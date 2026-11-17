import { describe, expect, it } from "vitest";
import { parseCheckoutContext } from "../../app/utils/checkout-input";
import { shopDomainFromDest } from "../../app/utils/checkout-http.server";

describe("parseCheckoutContext", () => {
  it("keeps well-formed lines and drops the rest", () => {
    const context = parseCheckoutContext({
      lines: [
        {
          productGid: "gid://shopify/Product/1",
          variantGid: "gid://shopify/ProductVariant/11",
          quantity: 2,
        },
        { productGid: "not-a-gid", quantity: 1 },
        { productGid: "gid://shopify/Product/2", quantity: 0 },
        { productGid: "gid://shopify/Product/3", quantity: 1.5 },
        {
          productGid: "gid://shopify/Product/4",
          variantGid: "gid://shopify/ProductVariant/44",
          quantity: 1,
        },
      ],
      subtotal: 42.5,
      country: "ca",
      shippingCountry: "us",
    });

    expect(context?.lines).toEqual([
      {
        productGid: "gid://shopify/Product/1",
        variantGid: "gid://shopify/ProductVariant/11",
        quantity: 2,
      },
      {
        productGid: "gid://shopify/Product/4",
        variantGid: "gid://shopify/ProductVariant/44",
        quantity: 1,
      },
    ]);
    expect(context?.subtotal).toBe(42.5);
    expect(context?.marketCountry).toBe("CA");
    expect(context?.shippingCountry).toBe("US");
    expect(context?.customerLoggedIn).toBeNull();
  });

  it("caps the number of lines it reads", () => {
    const lines = Array.from({ length: 80 }, (_, index) => ({
      productGid: `gid://shopify/Product/${index + 1}`,
      quantity: 1,
    }));

    expect(parseCheckoutContext({ lines })?.lines).toHaveLength(50);
  });

  it("rejects a non-object body", () => {
    expect(parseCheckoutContext(null)).toBeNull();
    expect(parseCheckoutContext([])).toBeNull();
    expect(parseCheckoutContext("lines=1")).toBeNull();
  });

  it("ignores invalid amounts and country codes", () => {
    const context = parseCheckoutContext({
      lines: [],
      subtotal: -4,
      country: "Canada",
      shippingCountry: "U1",
    });

    expect(context?.subtotal).toBeNull();
    expect(context?.marketCountry).toBeNull();
    expect(context?.shippingCountry).toBeNull();
  });

  it("accepts a numeric subtotal sent as a string", () => {
    expect(parseCheckoutContext({ subtotal: "19.99" })?.subtotal).toBe(19.99);
  });
});

describe("shopDomainFromDest", () => {
  it("normalizes signed shop URLs", () => {
    expect(shopDomainFromDest("https://example.myshopify.com")).toBe(
      "example.myshopify.com",
    );
    expect(shopDomainFromDest("https://Example.MyShopify.com/")).toBe(
      "example.myshopify.com",
    );
    expect(shopDomainFromDest("example.myshopify.com")).toBe(
      "example.myshopify.com",
    );
    expect(shopDomainFromDest("https://shop.example.com:8443/checkout")).toBe(
      "shop.example.com",
    );
  });

  it("rejects values that are not shop domains", () => {
    expect(shopDomainFromDest(null)).toBeNull();
    expect(shopDomainFromDest("")).toBeNull();
    expect(shopDomainFromDest("https://")).toBeNull();
    expect(shopDomainFromDest("localhost")).toBeNull();
    expect(shopDomainFromDest("not a domain")).toBeNull();
  });
});
