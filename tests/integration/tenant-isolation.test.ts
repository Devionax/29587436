import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import {
  createRule,
  deleteRule,
  duplicateRule,
  getRule,
  listRules,
  setRuleStatus,
  updateRule,
} from "../../app/services/rules.server";
import type { RuleWriteInput } from "../../app/services/rules.server";
import {
  InvalidInputError,
  TenantResourceNotFoundError,
} from "../../app/utils/errors";
import { createShop, prisma, ruleInput } from "../helpers/db";

describe("tenant isolation", () => {
  let shopA: Awaited<ReturnType<typeof createShop>>;
  let shopB: Awaited<ReturnType<typeof createShop>>;
  let ruleA: Awaited<ReturnType<typeof createRule>>;
  let ruleB: Awaited<ReturnType<typeof createRule>>;

  beforeAll(async () => {
    shopA = await createShop("a");
    shopB = await createShop("b");
    ruleA = await createRule(shopA.id, ruleInput("Rule A"));
    ruleB = await createRule(shopB.id, ruleInput("Rule B"));
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({
      where: { id: { in: [shopA.id, shopB.id] } },
    });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("stamps the authenticated shop on the rule and its children", () => {
    expect(ruleA.shopId).toBe(shopA.id);
    expect(ruleA.triggers[0]?.shopId).toBe(shopA.id);
    expect(ruleA.offers[0]?.shopId).toBe(shopA.id);
  });

  it("lists only the authenticated shop's rules", async () => {
    const rules = await listRules(shopA.id);
    expect(rules.map((rule) => rule.id)).toEqual([ruleA.id]);
    expect(rules.map((rule) => rule.id)).not.toContain(ruleB.id);
  });

  it("does not read another shop's rule", async () => {
    expect(await getRule(shopA.id, ruleB.id)).toBeNull();
  });

  it("does not update another shop's rule and leaves it unchanged", async () => {
    await expect(
      updateRule(shopA.id, ruleB.id, ruleInput("Hijacked")),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    const untouched = await getRule(shopB.id, ruleB.id);
    expect(untouched?.name).toBe("Rule B");
    expect(untouched?.status).toBe("ACTIVE");
  });

  it("does not delete another shop's rule", async () => {
    await expect(deleteRule(shopA.id, ruleB.id)).rejects.toBeInstanceOf(
      TenantResourceNotFoundError,
    );

    expect(await getRule(shopB.id, ruleB.id)).not.toBeNull();
  });

  it("does not duplicate another shop's rule", async () => {
    const before = await prisma.recommendationRule.count({
      where: { shopId: shopA.id },
    });

    await expect(duplicateRule(shopA.id, ruleB.id)).rejects.toBeInstanceOf(
      TenantResourceNotFoundError,
    );

    expect(
      await prisma.recommendationRule.count({ where: { shopId: shopA.id } }),
    ).toBe(before);
  });

  it("does not change another shop's rule status", async () => {
    await expect(setRuleStatus(shopA.id, ruleB.id, "PAUSED")).rejects.toBeInstanceOf(
      TenantResourceNotFoundError,
    );

    const untouched = await getRule(shopB.id, ruleB.id);
    expect(untouched?.status).toBe("ACTIVE");
  });

  it("changes status without touching trigger or offer rows", async () => {
    await setRuleStatus(shopA.id, ruleA.id, "PAUSED");

    const paused = await getRule(shopA.id, ruleA.id);
    expect(paused?.status).toBe("PAUSED");
    expect(paused?.triggers).toHaveLength(1);
    expect(paused?.offers).toHaveLength(1);

    await setRuleStatus(shopA.id, ruleA.id, "ACTIVE");
  });

  it("ignores a shopId forged in the request body", async () => {
    const forged = {
      ...ruleInput("Forged"),
      shopId: shopB.id,
    } as unknown as RuleWriteInput;

    const created = await createRule(shopA.id, forged);
    expect(created.shopId).toBe(shopA.id);
    expect(created.triggers[0]?.shopId).toBe(shopA.id);

    await prisma.recommendationRule.delete({ where: { id: created.id } });
  });

  it("rejects duplicate variants inside one rule", async () => {
    const duplicateOffers = ruleInput("Duplicates");
    duplicateOffers.offers.push({ ...duplicateOffers.offers[0]! });

    await expect(createRule(shopA.id, duplicateOffers)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it("scopes analytics deduplication and reads by shop", async () => {
    const dedupeKey = `${shopA.id}-impression-1`;
    const base = {
      eventType: "IMPRESSION" as const,
      surface: "PRODUCT_PAGE" as const,
      offerProductGid: "gid://shopify/Product/2",
      sessionKey: "anon-session-1",
      dedupeKey,
      occurredAt: new Date(),
    };

    await prisma.analyticsEvent.create({
      data: { ...base, shopId: shopA.id, ruleId: ruleA.id },
    });

    await expect(
      prisma.analyticsEvent.create({ data: { ...base, shopId: shopA.id } }),
    ).rejects.toThrow();

    expect(
      await prisma.analyticsEvent.count({ where: { dedupeKey } }),
    ).toBe(1);
    expect(
      await prisma.analyticsEvent.count({ where: { shopId: shopB.id } }),
    ).toBe(0);
  });

  it("allows the same product GID in different shops but not twice in one", async () => {
    const productGid = "gid://shopify/Product/777";
    const snapshot = (shopId: string) => ({
      shopId,
      productGid,
      title: "Shared GID",
      handle: "shared-gid",
      status: "ACTIVE",
      syncedAt: new Date(),
    });

    await prisma.productSnapshot.create({ data: snapshot(shopA.id) });
    await prisma.productSnapshot.create({ data: snapshot(shopB.id) });

    await expect(
      prisma.productSnapshot.create({ data: snapshot(shopA.id) }),
    ).rejects.toThrow();

    const variant = (shopId: string, productId: string) => ({
      shopId,
      productId,
      variantGid: "gid://shopify/ProductVariant/777",
      title: "Default",
      price: "19.99",
      syncedAt: new Date(),
    });
    const [productA, productB] = await Promise.all([
      prisma.productSnapshot.findFirstOrThrow({
        where: { shopId: shopA.id, productGid },
      }),
      prisma.productSnapshot.findFirstOrThrow({
        where: { shopId: shopB.id, productGid },
      }),
    ]);

    await prisma.productVariantSnapshot.create({
      data: variant(shopA.id, productA.id),
    });
    await prisma.productVariantSnapshot.create({
      data: variant(shopB.id, productB.id),
    });
    await expect(
      prisma.productVariantSnapshot.create({
        data: variant(shopA.id, productA.id),
      }),
    ).rejects.toThrow();
  });

  it("cascades shop-owned rows when a tenant is deleted", async () => {
    const shopC = await createShop("cascade");
    await createRule(shopC.id, ruleInput("Cascade rule"));
    await prisma.productSnapshot.create({
      data: {
        shopId: shopC.id,
        productGid: "gid://shopify/Product/999",
        title: "Cascade",
        handle: "cascade",
        status: "ACTIVE",
        syncedAt: new Date(),
      },
    });

    await prisma.shop.delete({ where: { id: shopC.id } });

    expect(
      await prisma.recommendationRule.count({ where: { shopId: shopC.id } }),
    ).toBe(0);
    expect(
      await prisma.triggerProduct.count({ where: { shopId: shopC.id } }),
    ).toBe(0);
    expect(
      await prisma.recommendedProduct.count({ where: { shopId: shopC.id } }),
    ).toBe(0);
    expect(
      await prisma.productSnapshot.count({ where: { shopId: shopC.id } }),
    ).toBe(0);
    expect(
      await prisma.shopSettings.count({ where: { shopId: shopC.id } }),
    ).toBe(0);
  });
});
