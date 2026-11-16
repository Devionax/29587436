import { describe, expect, it } from "vitest";
import { parseRuleForm } from "../../app/utils/rule-form.server";

const TRIGGER = "gid://shopify/Product/11";
const OFFER_PRODUCT = "gid://shopify/Product/22";
const OFFER_VARIANT = "gid://shopify/ProductVariant/2201";

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
    showOnProductPage: "on",
    showOnCartPage: "on",
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
    expect(parsed).toEqual({ ok: false, errors: { name: "Give the rule a name." } });
  });

  it("rejects an out-of-range priority", () => {
    const parsed = parseRuleForm(form({ priority: "-5" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.priority).toBeTruthy();
  });

  it("requires at least one placement", () => {
    const parsed = parseRuleForm(form({ showOnProductPage: null, showOnCartPage: null }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.surfaces).toBeTruthy();
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

  it("requires at least one trigger and one offer", () => {
    const noTriggers = parseRuleForm(form({ triggers: "[]" }));
    const noOffers = parseRuleForm(form({ offers: "[]" }));

    expect(noTriggers.ok).toBe(false);
    expect(noOffers.ok).toBe(false);
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
});
