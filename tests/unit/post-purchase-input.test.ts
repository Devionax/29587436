import { describe, expect, it } from "vitest";
import { buildPostPurchaseContext } from "../../app/utils/post-purchase-input";

function purchase(overrides: Record<string, unknown> = {}) {
  return {
    initialPurchase: {
      referenceId: "ref-1",
      customerId: "42",
      destinationCountryCode: "ca",
      totalPriceSet: { shopMoney: { amount: "84.50", currencyCode: "USD" } },
      lineItems: [
        {
          product: { id: 101, variant: { id: 1011 } },
          quantity: 2,
        },
      ],
      ...overrides,
    },
  };
}

describe("buildPostPurchaseContext", () => {
  it("maps the verified purchase into checkout context", () => {
    const context = buildPostPurchaseContext(purchase());

    expect(context).toEqual({
      lines: [
        {
          productGid: "gid://shopify/Product/101",
          variantGid: "gid://shopify/ProductVariant/1011",
          quantity: 2,
        },
      ],
      subtotal: null,
      customerLoggedIn: true,
      shippingCountry: "CA",
      marketCountry: null,
      orderTotal: 84.5,
      orderLineCount: 1,
    });
  });

  it("accepts numeric identifiers serialized as strings", () => {
    const context = buildPostPurchaseContext({
      initialPurchase: {
        lineItems: [{ product: { id: "101", variant: { id: "1011" } }, quantity: 1 }],
      },
    });

    expect(context?.lines[0]).toEqual({
      productGid: "gid://shopify/Product/101",
      variantGid: "gid://shopify/ProductVariant/1011",
      quantity: 1,
    });
  });

  it("drops malformed lines but counts the whole order", () => {
    const context = buildPostPurchaseContext(
      purchase({
        lineItems: [
          { product: { id: 101, variant: { id: 1011 } }, quantity: 1 },
          { product: { id: 0 }, quantity: 1 },
          { product: { id: 102 }, quantity: 0 },
          { product: {}, quantity: 1 },
          { product: { id: 103 }, quantity: 1.5 },
          { product: { id: 104, variant: { id: 1041 } }, quantity: 3 },
        ],
      }),
    );

    expect(context?.lines).toHaveLength(2);
    expect(context?.orderLineCount).toBe(6);
  });

  it("leaves unknown values null so conditions fail closed", () => {
    const context = buildPostPurchaseContext({
      initialPurchase: {
        lineItems: [{ product: { id: 101 }, quantity: 1 }],
      },
    });

    expect(context).toMatchObject({
      customerLoggedIn: false,
      shippingCountry: null,
      marketCountry: null,
      orderTotal: null,
    });
    expect(context?.lines[0]?.variantGid).toBeNull();
  });

  it("rejects a purchase that is not an object", () => {
    expect(buildPostPurchaseContext({})).toBeNull();
    expect(buildPostPurchaseContext({ initialPurchase: "x" })).toBeNull();
    expect(buildPostPurchaseContext({ initialPurchase: [] })).toBeNull();
  });

  it("caps the number of lines used for matching", () => {
    const lineItems = Array.from({ length: 260 }, (_, index) => ({
      product: { id: 1000 + index },
      quantity: 1,
    }));

    const context = buildPostPurchaseContext({ initialPurchase: { lineItems } });
    expect(context?.lines).toHaveLength(200);
    expect(context?.orderLineCount).toBe(260);
  });
});
