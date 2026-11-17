import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OfferSource } from "@prisma/client";
import db from "../../app/db.server";
import {
  createRule,
  duplicateRule,
  getRule,
  updateRule,
} from "../../app/services/rules.server";
import type { RuleWriteInput } from "../../app/services/rules.server";
import {
  InvalidInputError,
  PlanLimitError,
  TenantResourceNotFoundError,
} from "../../app/utils/errors";
import { createShop, prisma, ruleInput } from "../helpers/db";

describe("offer sources and placement settings", () => {
  let shop: Awaited<ReturnType<typeof createShop>>;

  beforeAll(async () => {
    shop = await createShop("offers");
  });

  afterAll(async () => {
    await prisma.shop.delete({ where: { id: shop.id } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("defaults a new rule to manual-only offers", async () => {
    const rule = await createRule(shop.id, ruleInput("Defaults"));

    expect(rule.sources).toEqual(["MANUAL"]);
    expect(rule.showOnCheckout).toBe(false);
    expect(rule.autoLookbackHours).toBe(168);
    expect(rule.autoMaxOffers).toBeNull();
    expect(rule.autoMinRepeats).toBe(2);
    expect(rule.prioritizeRepeats).toBe(true);
    expect(rule.startsAt).toBeNull();
    expect(rule.endsAt).toBeNull();

    await prisma.recommendationRule.delete({ where: { id: rule.id } });
  });

  it("persists source priority order and automatic settings", async () => {
    const sources: OfferSource[] = [
      "REPEATED_ACTIVITY",
      "MANUAL",
      "RECENTLY_REMOVED",
    ];
    const startsAt = new Date("2026-12-01T00:00:00Z");
    const endsAt = new Date("2026-12-31T00:00:00Z");

    const created = await createRule(shop.id, {
      ...ruleInput("Automated"),
      sources,
      showOnCheckout: true,
      autoLookbackHours: 24,
      autoMaxOffers: 5,
      autoMinRepeats: 3,
      prioritizeRepeats: false,
      startsAt,
      endsAt,
    });

    const loaded = await getRule(shop.id, created.id);
    expect(loaded?.sources).toEqual(sources);
    expect(loaded?.showOnCheckout).toBe(true);
    expect(loaded?.autoLookbackHours).toBe(24);
    expect(loaded?.autoMaxOffers).toBe(5);
    expect(loaded?.autoMinRepeats).toBe(3);
    expect(loaded?.prioritizeRepeats).toBe(false);
    expect(loaded?.startsAt).toEqual(startsAt);
    expect(loaded?.endsAt).toEqual(endsAt);

    await prisma.recommendationRule.delete({ where: { id: created.id } });
  });

  it("reorders sources and clears a schedule on update", async () => {
    const created = await createRule(shop.id, {
      ...ruleInput("Scheduled"),
      sources: ["MANUAL", "RECENTLY_REMOVED"],
      startsAt: new Date("2026-12-01T00:00:00Z"),
      endsAt: new Date("2026-12-02T00:00:00Z"),
    });

    const updated = await updateRule(shop.id, created.id, {
      ...ruleInput("Scheduled"),
      sources: ["RECENTLY_REMOVED", "MANUAL"],
      startsAt: null,
      endsAt: null,
    });

    expect(updated.sources).toEqual(["RECENTLY_REMOVED", "MANUAL"]);
    expect(updated.startsAt).toBeNull();
    expect(updated.endsAt).toBeNull();

    await prisma.recommendationRule.delete({ where: { id: created.id } });
  });

  it("leaves sources untouched when an older caller omits them", async () => {
    const created = await createRule(shop.id, {
      ...ruleInput("Legacy caller"),
      sources: ["MANUAL", "REPEATED_ACTIVITY"],
      autoLookbackHours: 48,
    });

    const updated = await updateRule(shop.id, created.id, ruleInput("Renamed"));

    expect(updated.name).toBe("Renamed");
    expect(updated.sources).toEqual(["MANUAL", "REPEATED_ACTIVITY"]);
    expect(updated.autoLookbackHours).toBe(48);

    await prisma.recommendationRule.delete({ where: { id: created.id } });
  });

  it("copies sources and schedule into a draft duplicate", async () => {
    const startsAt = new Date("2026-12-01T00:00:00Z");
    const created = await createRule(shop.id, {
      ...ruleInput("Original"),
      sources: ["REPEATED_ACTIVITY"],
      autoLookbackHours: 12,
      autoMaxOffers: 2,
      autoMinRepeats: 4,
      prioritizeRepeats: false,
      startsAt,
    });

    const copy = await duplicateRule(shop.id, created.id);

    expect(copy.status).toBe("DRAFT");
    expect(copy.sources).toEqual(["REPEATED_ACTIVITY"]);
    expect(copy.autoLookbackHours).toBe(12);
    expect(copy.autoMaxOffers).toBe(2);
    expect(copy.autoMinRepeats).toBe(4);
    expect(copy.prioritizeRepeats).toBe(false);
    expect(copy.startsAt).toEqual(startsAt);

    await prisma.recommendationRule.deleteMany({
      where: { id: { in: [created.id, copy.id] } },
    });
  });

  it("rejects an empty source list", async () => {
    await expect(
      createRule(shop.id, { ...ruleInput("No sources"), sources: [] }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects duplicate sources", async () => {
    await expect(
      createRule(shop.id, {
        ...ruleInput("Duplicated sources"),
        sources: ["MANUAL", "MANUAL"],
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("rejects an end date at or before the start date", async () => {
    const startsAt = new Date("2026-12-02T00:00:00Z");

    await expect(
      createRule(shop.id, {
        ...ruleInput("Bad window"),
        startsAt,
        endsAt: startsAt,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("counts an existing active rule when activating through update", async () => {
    const freeShop = await createShop("offers-active", { plan: "FREE" });
    const [active, draft] = await Promise.all([
      prisma.recommendationRule.create({
        data: { shopId: freeShop.id, name: "Active", status: "ACTIVE" },
      }),
      prisma.recommendationRule.create({
        data: { shopId: freeShop.id, name: "Draft", status: "DRAFT" },
      }),
    ]);

    await expect(
      updateRule(freeShop.id, draft.id, {
        ...ruleInput("Draft"),
        status: "ACTIVE",
      }),
    ).rejects.toBeInstanceOf(PlanLimitError);

    expect(
      (await prisma.recommendationRule.findUniqueOrThrow({ where: { id: draft.id } }))
        .status,
    ).toBe("DRAFT");
    expect(active.status).toBe("ACTIVE");

    await prisma.shop.delete({ where: { id: freeShop.id } });
  });

  it("keeps sources scoped to their tenant", async () => {
    const other = await createShop("offers-other");
    const theirs = await createRule(other.id, {
      ...ruleInput("Theirs"),
      sources: ["RECENTLY_REMOVED"],
    });

    const input: RuleWriteInput = {
      ...ruleInput("Hijack"),
      sources: ["MANUAL"],
    };
    await expect(updateRule(shop.id, theirs.id, input)).rejects.toBeInstanceOf(
      TenantResourceNotFoundError,
    );

    const untouched = await getRule(other.id, theirs.id);
    expect(untouched?.sources).toEqual(["RECENTLY_REMOVED"]);

    await prisma.shop.delete({ where: { id: other.id } });
  });
});
