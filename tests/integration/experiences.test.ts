import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import {
  deleteOfferExperience,
  listOfferExperiences,
  upsertOfferExperience,
} from "../../app/services/experiences.server";
import {
  createRule,
  duplicateRule,
  getRule,
  updateRule,
} from "../../app/services/rules.server";
import {
  InvalidInputError,
  TenantResourceNotFoundError,
} from "../../app/utils/errors";
import { createShop, prisma, ruleInput } from "../helpers/db";

function bothExperiences() {
  return [
    {
      experience: "PRE_PURCHASE" as const,
      enabled: true,
      headline: "Add before paying",
      body: "Checkout copy",
      ctaLabel: "Add to order",
    },
    {
      experience: "POST_PURCHASE" as const,
      enabled: true,
      headline: "One more thing",
      body: "Post-purchase copy",
      ctaLabel: "Add it",
    },
  ];
}

function byExperience(
  rows: Awaited<ReturnType<typeof listOfferExperiences>>,
  experience: "PRE_PURCHASE" | "POST_PURCHASE",
) {
  return rows.find((row) => row.experience === experience) ?? null;
}

describe("offer experiences", () => {
  let shop: Awaited<ReturnType<typeof createShop>>;
  let otherShop: Awaited<ReturnType<typeof createShop>>;

  beforeAll(async () => {
    shop = await createShop("experiences");
    otherShop = await createShop("experiences-other");
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({
      where: { id: { in: [shop.id, otherShop.id] } },
    });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("backfills a pre-purchase experience from showOnCheckout", async () => {
    const rule = await createRule(shop.id, {
      ...ruleInput("Legacy checkout"),
      showOnCheckout: true,
    });

    const rows = await listOfferExperiences(shop.id, rule.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shopId: shop.id,
      ruleId: rule.id,
      experience: "PRE_PURCHASE",
      enabled: true,
    });
    expect(rule.showOnCheckout).toBe(true);
  });

  it("creates no experiences when the legacy flag is omitted", async () => {
    const rule = await createRule(shop.id, ruleInput("No experiences"));

    expect(await listOfferExperiences(shop.id, rule.id)).toHaveLength(0);
    expect(rule.showOnCheckout).toBe(false);
  });

  it("creates an explicit experience set and derives the legacy flag", async () => {
    const rule = await createRule(shop.id, {
      ...ruleInput("Both experiences"),
      experiences: bothExperiences(),
    });

    const rows = await listOfferExperiences(shop.id, rule.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.shopId === shop.id)).toBe(true);
    expect(byExperience(rows, "PRE_PURCHASE")?.headline).toBe(
      "Add before paying",
    );
    expect(byExperience(rows, "POST_PURCHASE")?.ctaLabel).toBe("Add it");
    expect(rule.showOnCheckout).toBe(true);
  });

  it("derives a false legacy flag when pre-purchase is disabled", async () => {
    const rule = await createRule(shop.id, {
      ...ruleInput("Post only"),
      experiences: [
        { experience: "PRE_PURCHASE", enabled: false },
        { experience: "POST_PURCHASE", enabled: true },
      ],
    });

    expect(rule.showOnCheckout).toBe(false);
    const rows = await listOfferExperiences(shop.id, rule.id);
    expect(byExperience(rows, "PRE_PURCHASE")?.enabled).toBe(false);
    expect(byExperience(rows, "POST_PURCHASE")?.enabled).toBe(true);
  });

  it("rejects an explicit set that contradicts showOnCheckout", async () => {
    await expect(
      createRule(shop.id, {
        ...ruleInput("Contradiction"),
        showOnCheckout: false,
        experiences: [{ experience: "PRE_PURCHASE", enabled: true }],
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    const count = await prisma.recommendationRule.count({
      where: { shopId: shop.id, name: "Contradiction" },
    });
    expect(count).toBe(0);
  });

  it("rejects duplicate experience entries before writing anything", async () => {
    await expect(
      createRule(shop.id, {
        ...ruleInput("Duplicate entries"),
        experiences: [
          { experience: "PRE_PURCHASE", enabled: true },
          { experience: "PRE_PURCHASE", enabled: false },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    const count = await prisma.recommendationRule.count({
      where: { shopId: shop.id, name: "Duplicate entries" },
    });
    expect(count).toBe(0);
  });

  it("treats an explicit update set as complete and disables unlisted rows", async () => {
    const rule = await createRule(shop.id, {
      ...ruleInput("Complete set"),
      experiences: bothExperiences(),
    });

    await updateRule(shop.id, rule.id, {
      ...ruleInput("Complete set"),
      experiences: [
        {
          experience: "PRE_PURCHASE",
          enabled: true,
          headline: "Updated pre-purchase",
        },
      ],
    });

    const rows = await listOfferExperiences(shop.id, rule.id);
    expect(rows).toHaveLength(2);
    expect(byExperience(rows, "PRE_PURCHASE")?.headline).toBe(
      "Updated pre-purchase",
    );
    expect(byExperience(rows, "PRE_PURCHASE")?.enabled).toBe(true);
    expect(byExperience(rows, "POST_PURCHASE")?.enabled).toBe(false);
    expect(byExperience(rows, "POST_PURCHASE")?.body).toBe(
      "Post-purchase copy",
    );
    expect((await getRule(shop.id, rule.id))?.showOnCheckout).toBe(true);
  });

  it("preserves every experience row when the update omits both fields", async () => {
    const rule = await createRule(shop.id, {
      ...ruleInput("Preserved"),
      experiences: bothExperiences(),
    });

    await updateRule(shop.id, rule.id, ruleInput("Preserved renamed"));

    const rows = await listOfferExperiences(shop.id, rule.id);
    expect(rows).toHaveLength(2);
    expect(byExperience(rows, "PRE_PURCHASE")).toMatchObject({
      enabled: true,
      headline: "Add before paying",
      body: "Checkout copy",
    });
    expect(byExperience(rows, "POST_PURCHASE")).toMatchObject({
      enabled: true,
      headline: "One more thing",
      body: "Post-purchase copy",
    });
    expect((await getRule(shop.id, rule.id))?.showOnCheckout).toBe(true);
  });

  it("reconciles only pre-purchase when the legacy flag is supplied alone", async () => {
    const rule = await createRule(shop.id, {
      ...ruleInput("Legacy only"),
      experiences: bothExperiences(),
    });

    await updateRule(shop.id, rule.id, {
      ...ruleInput("Legacy only"),
      showOnCheckout: false,
    });

    const rows = await listOfferExperiences(shop.id, rule.id);
    expect(rows).toHaveLength(2);
    expect(byExperience(rows, "PRE_PURCHASE")?.enabled).toBe(false);
    expect(byExperience(rows, "PRE_PURCHASE")?.headline).toBe(
      "Add before paying",
    );
    expect(byExperience(rows, "POST_PURCHASE")?.enabled).toBe(true);
    expect((await getRule(shop.id, rule.id))?.showOnCheckout).toBe(false);
  });

  it("duplicates both experiences and their overrides without extra rows", async () => {
    const source = await createRule(shop.id, {
      ...ruleInput("Duplicated"),
      experiences: bothExperiences(),
    });

    const copy = await duplicateRule(shop.id, source.id);
    const rows = await listOfferExperiences(shop.id, copy.id);

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.experience)).size).toBe(2);
    expect(byExperience(rows, "PRE_PURCHASE")?.headline).toBe(
      "Add before paying",
    );
    expect(byExperience(rows, "POST_PURCHASE")?.body).toBe(
      "Post-purchase copy",
    );
    expect(copy.showOnCheckout).toBe(true);
  });

  it("does not read, create, or delete another shop's experiences", async () => {
    const ownRule = await createRule(shop.id, {
      ...ruleInput("Owned"),
      experiences: bothExperiences(),
    });
    const otherRule = await createRule(otherShop.id, {
      ...ruleInput("Other tenant"),
      experiences: bothExperiences(),
    });

    await expect(
      listOfferExperiences(shop.id, otherRule.id),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    await expect(
      upsertOfferExperience(shop.id, otherRule.id, {
        experience: "PRE_PURCHASE",
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    await expect(
      deleteOfferExperience(shop.id, otherRule.id, "PRE_PURCHASE"),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    const otherRows = await prisma.offerExperience.findMany({
      where: { ruleId: otherRule.id },
    });
    expect(otherRows).toHaveLength(2);
    expect(otherRows.every((row) => row.shopId === otherShop.id)).toBe(true);

    const ownRows = await listOfferExperiences(shop.id, ownRule.id);
    expect(ownRows.every((row) => row.shopId === shop.id)).toBe(true);
  });

  it("scopes an upsert to the owning rule and stores the authenticated shop", async () => {
    const rule = await createRule(shop.id, ruleInput("Upsert target"));

    const created = await upsertOfferExperience(shop.id, rule.id, {
      experience: "POST_PURCHASE",
      headline: "  Only after checkout  ",
    });

    expect(created).toMatchObject({
      shopId: shop.id,
      ruleId: rule.id,
      experience: "POST_PURCHASE",
      enabled: true,
      headline: "Only after checkout",
      body: null,
      ctaLabel: null,
    });
    expect((await getRule(shop.id, rule.id))?.showOnCheckout).toBe(false);

    const updated = await upsertOfferExperience(shop.id, rule.id, {
      experience: "POST_PURCHASE",
      enabled: false,
      body: "Updated body",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.enabled).toBe(false);
    expect(updated.body).toBe("Updated body");
    expect(updated.headline).toBeNull();
  });

  it("cascades experience rows when the owning rule is deleted", async () => {
    const rule = await createRule(shop.id, {
      ...ruleInput("Cascade"),
      experiences: bothExperiences(),
    });

    await prisma.recommendationRule.delete({ where: { id: rule.id } });

    const remaining = await prisma.offerExperience.count({
      where: { ruleId: rule.id },
    });
    expect(remaining).toBe(0);
  });
});
