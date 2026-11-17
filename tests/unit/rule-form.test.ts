import { describe, expect, it } from "vitest";
import { parseRuleForm as baseParseRuleForm } from "../../app/utils/rule-form.server";
import type { RuleFormOptions } from "../../app/utils/rule-form.server";

const TRIGGER = "gid://shopify/Product/11";
const OFFER_PRODUCT = "gid://shopify/Product/22";
const OFFER_VARIANT = "gid://shopify/ProductVariant/2201";

const ALLOW_ALL: RuleFormOptions = {
  prePurchaseAvailable: true,
  postPurchaseAvailable: true,
};

function parseRuleForm(form: FormData, options: RuleFormOptions = ALLOW_ALL) {
  return baseParseRuleForm(form, options);
}

function form(overrides: Record<string, string | null> = {}): FormData {
  const data = new FormData();
  const values: Record<string, string | null> = {
    name: "Complete the look",
    description: "",
    status: "ACTIVE",
    priority: "10",
    matchMode: "ANY",
    heading: "Pairs well with",
    maxOffers: "",
    experiences: JSON.stringify([
      { experience: "PRE_PURCHASE", enabled: true, headline: "", body: "", ctaLabel: "" },
    ]),
    triggers: JSON.stringify([{ productGid: TRIGGER, variantGid: "" }]),
    offers: JSON.stringify([
      {
        productGid: OFFER_PRODUCT,
        variantGid: OFFER_VARIANT,
        defaultQuantity: 1,
        minQuantity: 1,
        maxQuantity: 5,
      },
    ]),
    ...overrides,
  };

  for (const [key, value] of Object.entries(values)) {
    if (value !== null) data.set(key, value);
  }
  return data;
}

describe("rule form validation", () => {
  it("accepts a valid rule and normalizes optional fields", () => {
    const parsed = parseRuleForm(form({ description: "  ", maxOffers: "" }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.input.name).toBe("Complete the look");
    expect(parsed.input.description).toBeNull();
    expect(parsed.input.maxOffers).toBeNull();
    expect(parsed.input.triggers).toEqual([{ productGid: TRIGGER, variantGid: null }]);
    expect(parsed.input.offers[0]).toMatchObject({
      variantGid: OFFER_VARIANT,
      defaultQuantity: 1,
      maxQuantity: 5,
      position: 0,
    });
  });

  it("requires a name", () => {
    const parsed = parseRuleForm(form({ name: "   " }));
    expect(parsed).toEqual({ ok: false, errors: { name: "Give the offer a name." } });
  });

  it("rejects an out-of-range priority", () => {
    const parsed = parseRuleForm(form({ priority: "-5" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.priority).toBeTruthy();
  });

  it("requires a delivery surface: a placement or an enabled experience", () => {
    const empty = parseRuleForm(form({ experiences: "[]" }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.experiences).toBeTruthy();

    const disabled = parseRuleForm(
      form({
        experiences: JSON.stringify([
          { experience: "PRE_PURCHASE", enabled: false },
        ]),
      }),
    );
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.errors.experiences).toMatch(/placement/i);

    // A storefront placement alone is enough; checkout is optional.
    const storefrontOnly = parseRuleForm(
      form({
        showOnProductPage: "on",
        experiences: JSON.stringify([
          { experience: "PRE_PURCHASE", enabled: false },
        ]),
      }),
    );
    expect(storefrontOnly.ok).toBe(true);
    if (storefrontOnly.ok) {
      expect(storefrontOnly.input.showOnProductPage).toBe(true);
      expect(storefrontOnly.input.showOnCartPage).toBe(false);
    }
  });

  it("rejects unreadable or invalid experience payloads", () => {
    const badJson = parseRuleForm(form({ experiences: "{not json" }));
    const unknown = parseRuleForm(
      form({
        experiences: JSON.stringify([{ experience: "CART_PAGE", enabled: true }]),
      }),
    );
    const duplicate = parseRuleForm(
      form({
        experiences: JSON.stringify([
          { experience: "PRE_PURCHASE", enabled: true },
          { experience: "PRE_PURCHASE", enabled: true },
        ]),
      }),
    );

    expect(badJson.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    expect(duplicate.ok).toBe(false);
  });

  it("rejects experience copy over its limits", () => {
    const parsed = parseRuleForm(
      form({
        experiences: JSON.stringify([
          {
            experience: "PRE_PURCHASE",
            enabled: true,
            headline: "x".repeat(121),
          },
        ]),
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.experiences).toMatch(/too long/);
  });

  it("rejects unknown status values", () => {
    const parsed = parseRuleForm(form({ status: "LIVE" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.status).toBeTruthy();
  });

  it("rejects a non-Shopify product id", () => {
    const parsed = parseRuleForm(
      form({ triggers: JSON.stringify([{ productGid: "https://evil.test", variantGid: "" }]) }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.triggers).toBeTruthy();
  });

  it("allows a trigger-less manual offer but still requires an offer", () => {
    const noTriggers = parseRuleForm(form({ triggers: "[]" }));
    const noOffers = parseRuleForm(form({ offers: "[]" }));

    expect(noTriggers.ok).toBe(true);
    if (noTriggers.ok) {
      expect(noTriggers.input.triggers).toEqual([]);
      expect(noTriggers.input.sources).toEqual(["MANUAL"]);
    }
    expect(noOffers.ok).toBe(false);
  });

  it("requires a trigger product when Manual is not a source", () => {
    const parsed = parseRuleForm(
      form({ triggers: "[]", sources: JSON.stringify(["RECENTLY_REMOVED"]) }),
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.triggers).toBeTruthy();
  });

  it("rejects an offer without a variant", () => {
    const parsed = parseRuleForm(
      form({
        offers: JSON.stringify([{ productGid: OFFER_PRODUCT, variantGid: "" }]),
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.offers).toBeTruthy();
  });

  it("rejects impossible quantity ranges", () => {
    const parsed = parseRuleForm(
      form({
        offers: JSON.stringify([
          {
            productGid: OFFER_PRODUCT,
            variantGid: OFFER_VARIANT,
            defaultQuantity: 5,
            minQuantity: 6,
            maxQuantity: 10,
          },
        ]),
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.offers).toBeTruthy();
  });

  it("rejects unparseable payloads", () => {
    const parsed = parseRuleForm(form({ triggers: "{not json" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.triggers).toBeTruthy();
  });

  it("caps the offer limit", () => {
    const parsed = parseRuleForm(form({ maxOffers: "50" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.maxOffers).toBeTruthy();
  });

  it("defaults to manual-only sources and conservative automation settings", () => {
    const parsed = parseRuleForm(form());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.input.sources).toEqual(["MANUAL"]);
    expect(parsed.input.autoLookbackHours).toBe(168);
    expect(parsed.input.autoMaxOffers).toBeNull();
    expect(parsed.input.autoMinRepeats).toBe(2);
    expect(parsed.input.prioritizeRepeats).toBe(false);
    expect(parsed.input.startsAt).toBeNull();
    expect(parsed.input.endsAt).toBeNull();
  });

  it("accepts automatic sources without manual products", () => {
    const parsed = parseRuleForm(
      form({
        sources: JSON.stringify(["RECENTLY_REMOVED", "REPEATED_ACTIVITY"]),
        offers: "[]",
        autoLookbackHours: "48",
        autoMaxOffers: "4",
        autoMinRepeats: "3",
        prioritizeRepeats: "on",
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.sources).toEqual(["RECENTLY_REMOVED", "REPEATED_ACTIVITY"]);
    expect(parsed.input.offers).toEqual([]);
    expect(parsed.input.autoLookbackHours).toBe(48);
    expect(parsed.input.autoMaxOffers).toBe(4);
    expect(parsed.input.autoMinRepeats).toBe(3);
    expect(parsed.input.prioritizeRepeats).toBe(true);
  });

  it("requires manual products when the manual source is selected", () => {
    const parsed = parseRuleForm(
      form({ sources: JSON.stringify(["MANUAL", "REPEATED_ACTIVITY"]), offers: "[]" }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.offers).toMatch(/Manual source/);
  });

  it("rejects empty, unknown, or duplicated sources", () => {
    const empty = parseRuleForm(form({ sources: "[]" }));
    const unknown = parseRuleForm(form({ sources: JSON.stringify(["CART"]) }));
    const duplicate = parseRuleForm(form({ sources: JSON.stringify(["MANUAL", "MANUAL"]) }));

    expect(empty.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    expect(duplicate.ok).toBe(false);
  });

  it("caps automatic settings at their documented bounds", () => {
    const parsed = parseRuleForm(
      form({
        sources: JSON.stringify(["REPEATED_ACTIVITY"]),
        offers: "[]",
        autoLookbackHours: "2161",
        autoMaxOffers: "11",
        autoMinRepeats: "21",
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.autoLookbackHours).toBeTruthy();
    expect(parsed.errors.autoMaxOffers).toBeTruthy();
    expect(parsed.errors.autoMinRepeats).toBeTruthy();
  });

  it("parses schedule dates as whole UTC days", () => {
    const parsed = parseRuleForm(
      form({ startsAt: "2026-12-01", endsAt: "2026-12-31" }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.startsAt?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(parsed.input.endsAt?.toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });

  it("rejects a schedule that ends before it starts", () => {
    const parsed = parseRuleForm(
      form({ startsAt: "2026-12-31", endsAt: "2026-12-01" }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.endsAt).toBeTruthy();
  });

  it("blocks pre-purchase unless the store is Plus", () => {
    const blocked = parseRuleForm(form(), { postPurchaseAvailable: true });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.errors.experiences).toMatch(/Plus/);
  });

  it("keeps a post-purchase configuration the deployment cannot deliver yet", () => {
    const parsed = parseRuleForm(
      form({
        experiences: JSON.stringify([
          { experience: "POST_PURCHASE", enabled: true },
        ]),
      }),
      { prePurchaseAvailable: true },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.experiences).toContainEqual(
      expect.objectContaining({ experience: "POST_PURCHASE", enabled: true }),
    );
  });

  it("keeps disabled experiences without delivering them", () => {
    const parsed = parseRuleForm(
      form({
        experiences: JSON.stringify([
          { experience: "PRE_PURCHASE", enabled: true },
          { experience: "POST_PURCHASE", enabled: false, headline: "Add more" },
        ]),
      }),
      { prePurchaseAvailable: true, postPurchaseAvailable: false },
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.experiences).toEqual([
      {
        experience: "PRE_PURCHASE",
        enabled: true,
        headline: null,
        body: null,
        ctaLabel: null,
      },
      {
        experience: "POST_PURCHASE",
        enabled: false,
        headline: "Add more",
        body: null,
        ctaLabel: null,
      },
    ]);
  });
});

describe("rule form conditions", () => {
  it("parses a flat condition group", () => {
    const parsed = parseRuleForm(
      form({
        conditions: JSON.stringify([
          { field: "CART_SUBTOTAL", operator: "GTE", value: 50 },
          { field: "CUSTOMER_LOGGED_IN", operator: "EQ", value: true },
        ]),
        conditionJoin: "OR",
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.conditions).toEqual([
      {
        joinOp: "OR",
        conditions: [
          { field: "CART_SUBTOTAL", operator: "GTE", valueJson: 50 },
          { field: "CUSTOMER_LOGGED_IN", operator: "EQ", valueJson: true },
        ],
      },
    ]);
  });

  it("clears conditions when the list is empty", () => {
    const parsed = parseRuleForm(form({ conditions: "[]" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input.conditions).toEqual([]);
  });

  it("leaves conditions untouched when they are locked", () => {
    const parsed = parseRuleForm(
      form({
        conditionsLocked: "1",
        conditions: JSON.stringify([
          { field: "CART_SUBTOTAL", operator: "GTE", value: 50 },
        ]),
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input.conditions).toBeUndefined();
  });

  it("rejects unsupported fields and invalid values", () => {
    const unsupported = parseRuleForm(
      form({
        conditions: JSON.stringify([{ field: "ORDER_TOTAL", operator: "GTE", value: 5 }]),
      }),
    );
    const negative = parseRuleForm(
      form({
        conditions: JSON.stringify([
          { field: "CART_SUBTOTAL", operator: "GTE", value: -1 },
        ]),
      }),
    );
    const badJoin = parseRuleForm(
      form({
        conditions: JSON.stringify([
          { field: "CART_SUBTOTAL", operator: "GTE", value: 5 },
        ]),
        conditionJoin: "XOR",
      }),
    );

    expect(unsupported.ok).toBe(false);
    expect(negative.ok).toBe(false);
    expect(badJoin.ok).toBe(false);
  });
});
