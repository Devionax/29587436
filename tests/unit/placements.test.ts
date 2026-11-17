import { afterEach, describe, expect, it } from "vitest";
import {
  defaultOfferExperiences,
  getExperienceSupport,
  isPostPurchaseEnabled,
  noExperienceReason,
} from "../../app/services/placements.server";

const previous = process.env.POST_PURCHASE_ENABLED;

afterEach(() => {
  if (previous === undefined) delete process.env.POST_PURCHASE_ENABLED;
  else process.env.POST_PURCHASE_ENABLED = previous;
});

describe("checkout experience support", () => {
  it("restricts pre-purchase to Plus stores", () => {
    const plus = getExperienceSupport({ isPlus: true });
    const nonPlus = getExperienceSupport({ isPlus: false });

    expect(plus.PRE_PURCHASE).toMatchObject({
      available: true,
      implemented: true,
      delivery: "CHECKOUT_UI_EXTENSION",
    });
    expect(nonPlus.PRE_PURCHASE.available).toBe(false);
    expect(nonPlus.PRE_PURCHASE.note).toMatch(/Plus/);
  });

  it("decides pre-purchase from isPlus alone", () => {
    expect(getExperienceSupport({ isPlus: false }).PRE_PURCHASE.available).toBe(false);
    expect(getExperienceSupport({ isPlus: true }).PRE_PURCHASE.available).toBe(true);
  });

  it("keeps post-purchase off unless the deployment flag is true", () => {
    delete process.env.POST_PURCHASE_ENABLED;
    expect(isPostPurchaseEnabled()).toBe(false);
    expect(getExperienceSupport({ isPlus: true }).POST_PURCHASE.available).toBe(false);

    process.env.POST_PURCHASE_ENABLED = "false";
    expect(isPostPurchaseEnabled()).toBe(false);

    process.env.POST_PURCHASE_ENABLED = "true";
    expect(isPostPurchaseEnabled()).toBe(true);
    expect(getExperienceSupport({ isPlus: false }).POST_PURCHASE.available).toBe(true);
  });

  it("never reports an unavailable experience without an explanation", () => {
    delete process.env.POST_PURCHASE_ENABLED;
    for (const shop of [{ isPlus: true }, { isPlus: false }]) {
      for (const support of Object.values(getExperienceSupport(shop))) {
        if (!support.available) expect(support.note.length).toBeGreaterThan(0);
      }
    }
  });

  it("defaults new offers to every available experience", () => {
    delete process.env.POST_PURCHASE_ENABLED;
    expect(defaultOfferExperiences({ isPlus: true }).map((e) => e.experience)).toEqual([
      "PRE_PURCHASE",
    ]);
    expect(defaultOfferExperiences({ isPlus: false })).toEqual([]);

    process.env.POST_PURCHASE_ENABLED = "true";
    expect(defaultOfferExperiences({ isPlus: true }).map((e) => e.experience)).toEqual([
      "PRE_PURCHASE",
      "POST_PURCHASE",
    ]);
    expect(defaultOfferExperiences({ isPlus: false }).map((e) => e.experience)).toEqual([
      "POST_PURCHASE",
    ]);
  });

  it("explains why a store cannot deliver offers at all", () => {
    delete process.env.POST_PURCHASE_ENABLED;
    expect(noExperienceReason({ isPlus: false })).toMatch(/Plus/);
    expect(noExperienceReason({ isPlus: true })).toBeNull();

    process.env.POST_PURCHASE_ENABLED = "true";
    expect(noExperienceReason({ isPlus: false })).toBeNull();
  });
});
