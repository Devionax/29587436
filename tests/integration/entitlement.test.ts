import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import {
  ENTITLEMENT_TTL_MS,
  getEntitlement,
  syncEntitlement,
} from "../../app/services/entitlement.server";
import { createRule, setRuleStatus } from "../../app/services/rules.server";
import { PlanLimitError } from "../../app/utils/errors";
import { createShop, prisma, ruleInput } from "../helpers/db";

type Captured = { calls: number };

function subscriptionResponse(planHandle: string | null, status = "ACTIVE") {
  return {
    data: {
      currentAppInstallation: {
        activeSubscriptions:
          planHandle === null
            ? []
            : [
                {
                  id: "gid://shopify/AppSubscription/1",
                  name: "Plan",
                  status,
                  currentPeriodEnd: "2026-12-01T00:00:00Z",
                  trialDays: 0,
                  lineItems: [
                    {
                      plan: {
                        pricingDetails: {
                          __typename: "AppRecurringPricing",
                          planHandle,
                        },
                      },
                    },
                  ],
                },
              ],
      },
    },
  };
}

function fakeAdmin(payload: unknown, captured: Captured): AdminApiContext {
  return {
    graphql: async () => {
      captured.calls += 1;
      return { json: async () => payload } as Response;
    },
  } as unknown as AdminApiContext;
}

function freeRuleInput(name: string) {
  const base = ruleInput(name);
  return {
    ...base,
    triggers: [{ productGid: `gid://shopify/Product/${name.length}01` }],
    offers: [
      {
        productGid: "gid://shopify/Product/2",
        variantGid: `gid://shopify/ProductVariant/${name.length}02`,
      },
    ],
  };
}

describe("entitlements and plan limits", () => {
  let freeShop: Awaited<ReturnType<typeof createShop>>;
  let proShop: Awaited<ReturnType<typeof createShop>>;

  beforeAll(async () => {
    freeShop = await createShop("plan-free", { plan: "FREE" });
    proShop = await createShop("plan-pro");
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({
      where: { id: { in: [freeShop.id, proShop.id] } },
    });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("defaults to the free plan when no subscription is cached", async () => {
    const entitlement = await getEntitlement(freeShop.id);

    expect(entitlement.planId).toBe("FREE");
    expect(entitlement.source).toBe("default");
    expect(entitlement.limits.maxRules).toBe(1);
    expect(entitlement.limits.maxOffersPerRule).toBe(3);
  });

  it("reads the cached paid plan", async () => {
    const entitlement = await getEntitlement(proShop.id);

    expect(entitlement.planId).toBe("PRO");
    expect(entitlement.status).toBe("ACTIVE");
    expect(entitlement.limits.maxRules).toBeNull();
  });

  it("blocks a second rule on the free plan", async () => {
    await createRule(freeShop.id, freeRuleInput("First"));

    await expect(
      createRule(freeShop.id, freeRuleInput("Second")),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });

  it("blocks activation when the active-rule limit is reached", async () => {
    const draft = await prisma.recommendationRule.create({
      data: { shopId: freeShop.id, name: "Draft", status: "DRAFT" },
    });
    await prisma.recommendationRule.updateMany({
      where: { shopId: freeShop.id, id: { not: draft.id } },
      data: { status: "ACTIVE" },
    });

    await expect(
      setRuleStatus(freeShop.id, draft.id, "ACTIVE"),
    ).rejects.toBeInstanceOf(PlanLimitError);

    expect(
      (await prisma.recommendationRule.findUniqueOrThrow({ where: { id: draft.id } }))
        .status,
    ).toBe("DRAFT");
  });

  it("blocks offers above the per-rule limit on the free plan", async () => {
    const shop = await createShop("plan-offers", { plan: "FREE" });
    const input = freeRuleInput("Offers");
    input.offers = Array.from({ length: 4 }, (_, index) => ({
      productGid: `gid://shopify/Product/7${index}`,
      variantGid: `gid://shopify/ProductVariant/7${index}`,
    }));

    await expect(createRule(shop.id, input)).rejects.toMatchObject({
      name: "PlanLimitError",
      limit: "OFFERS",
    });

    await prisma.shop.delete({ where: { id: shop.id } });
  });

  it("does not apply free limits to a pro shop", async () => {
    for (let index = 0; index < 3; index += 1) {
      await createRule(proShop.id, freeRuleInput(`Pro ${index}`));
    }

    expect(
      await prisma.recommendationRule.count({ where: { shopId: proShop.id } }),
    ).toBe(3);
  });

  it("reconciles an active subscription and caches it", async () => {
    const shop = await createShop("plan-sync-growth", { plan: "FREE" });
    const captured: Captured = { calls: 0 };

    const entitlement = await syncEntitlement(
      shop.id,
      fakeAdmin(subscriptionResponse("growth"), captured),
      { force: true },
    );

    expect(entitlement).toMatchObject({
      planId: "GROWTH",
      status: "ACTIVE",
      source: "shopify",
    });

    const row = await prisma.subscription.findUniqueOrThrow({
      where: { shopId: shop.id },
    });
    expect(row.planName).toBe("GROWTH");
    expect(row.shopifySubscriptionGid).toBe("gid://shopify/AppSubscription/1");
    expect(row.lastVerifiedAt).not.toBeNull();

    await prisma.shop.delete({ where: { id: shop.id } });
  });

  it("treats an unknown paid handle as the lowest paid tier", async () => {
    const shop = await createShop("plan-unknown", { plan: "FREE" });
    const captured: Captured = { calls: 0 };

    const entitlement = await syncEntitlement(
      shop.id,
      fakeAdmin(subscriptionResponse("mystery-tier"), captured),
      { force: true },
    );

    expect(entitlement.planId).toBe("GROWTH");
    await prisma.shop.delete({ where: { id: shop.id } });
  });

  it("falls back to free when Shopify reports no active subscription", async () => {
    const shop = await createShop("plan-none", { plan: "FREE" });
    const captured: Captured = { calls: 0 };

    const entitlement = await syncEntitlement(
      shop.id,
      fakeAdmin(subscriptionResponse(null), captured),
      { force: true },
    );

    expect(entitlement.planId).toBe("FREE");
    expect(entitlement.status).toBe("PENDING");

    const row = await prisma.subscription.findUniqueOrThrow({
      where: { shopId: shop.id },
    });
    expect(row.planName).toBe("FREE");
    await prisma.shop.delete({ where: { id: shop.id } });
  });

  it("serves the cache inside the TTL without calling Shopify", async () => {
    const shop = await createShop("plan-cache", { plan: "GROWTH" });
    const captured: Captured = { calls: 0 };

    const entitlement = await syncEntitlement(
      shop.id,
      fakeAdmin(subscriptionResponse("pro"), captured),
    );

    expect(entitlement.planId).toBe("GROWTH");
    expect(entitlement.source).toBe("cache");
    expect(captured.calls).toBe(0);
    await prisma.shop.delete({ where: { id: shop.id } });
  });

  it("refreshes after the TTL and when forced", async () => {
    const shop = await createShop("plan-ttl", { plan: "FREE" });
    await prisma.subscription.create({
      data: {
        shopId: shop.id,
        planName: "GROWTH",
        status: "ACTIVE",
        lastVerifiedAt: new Date(Date.now() - ENTITLEMENT_TTL_MS - 1000),
      },
    });
    const captured: Captured = { calls: 0 };

    await syncEntitlement(
      shop.id,
      fakeAdmin(subscriptionResponse("pro"), captured),
    );
    expect(captured.calls).toBe(1);

    await syncEntitlement(
      shop.id,
      fakeAdmin(subscriptionResponse("pro"), captured),
      { force: true },
    );
    expect(captured.calls).toBe(2);

    await prisma.shop.delete({ where: { id: shop.id } });
  });

  it("keeps the cached plan when the Admin API fails", async () => {
    const shop = await createShop("plan-failure", { plan: "GROWTH" });
    await prisma.subscription.update({
      where: { shopId: shop.id },
      data: { lastVerifiedAt: new Date(Date.now() - ENTITLEMENT_TTL_MS - 1000) },
    });

    const failing = {
      graphql: async () => {
        throw new Error("network down");
      },
    } as unknown as AdminApiContext;

    const entitlement = await syncEntitlement(shop.id, failing);
    expect(entitlement.planId).toBe("GROWTH");
    expect(entitlement.source).toBe("cache");

    await prisma.shop.delete({ where: { id: shop.id } });
  });
});
