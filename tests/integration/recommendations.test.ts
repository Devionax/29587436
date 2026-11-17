import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import { upsertProductSnapshot } from "../../app/services/catalog.server";
import type { CatalogProduct } from "../../app/services/catalog.server";
import { getStorefrontRecommendations } from "../../app/services/recommendations.server";
import { createRule, setRuleStatus } from "../../app/services/rules.server";
import { DEFAULT_SETTINGS, updateSettings } from "../../app/services/settings.server";
import { parseCartLines, parseSurface } from "../../app/utils/storefront-input";
import { createShop, prisma } from "../helpers/db";

const TRIGGER = "gid://shopify/Product/501";
const OFFER = "gid://shopify/Product/502";
const OFFER_VARIANT = "gid://shopify/ProductVariant/50201";
const OFFER_B = "gid://shopify/Product/503";
const OFFER_B_VARIANT = "gid://shopify/ProductVariant/50301";

function snapshot(): CatalogProduct {
  return {
    productGid: OFFER,
    title: "Shoe care kit",
    handle: "shoe-care-kit",
    status: "ACTIVE",
    imageUrl: "https://cdn.example.com/kit.png",
    availableForSale: true,
    priceMin: "19.00",
    priceMax: "29.00",
    currencyCode: "USD",
    variants: [
      {
        variantGid: OFFER_VARIANT,
        title: "Standard",
        price: "19.00",
        compareAtPrice: "25.00",
        availableForSale: true,
        position: 0,
      },
    ],
  };
}

function secondSnapshot(): CatalogProduct {
  return {
    productGid: OFFER_B,
    title: "Travel shoe horn",
    handle: "travel-shoe-horn",
    status: "ACTIVE",
    imageUrl: null,
    availableForSale: true,
    priceMin: "9.00",
    priceMax: "9.00",
    currencyCode: "USD",
    variants: [
      {
        variantGid: OFFER_B_VARIANT,
        title: "Default",
        price: "9.00",
        compareAtPrice: null,
        availableForSale: true,
        position: 0,
      },
    ],
  };
}

function cartLine() {
  return [{ productGid: TRIGGER, variantGid: null, quantity: 1 }];
}

describe("storefront recommendations", () => {
  let shopA: Awaited<ReturnType<typeof createShop>>;
  let shopB: Awaited<ReturnType<typeof createShop>>;

  beforeAll(async () => {
    shopA = await createShop("rec-a");
    shopB = await createShop("rec-b");

    await upsertProductSnapshot(shopA.id, snapshot());
    await upsertProductSnapshot(shopA.id, secondSnapshot());

    await createRule(shopA.id, {
      name: "Shoe care",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      heading: "Complete your pair",
      showOnProductPage: true,
      showOnCartPage: false,
      triggers: [{ productGid: TRIGGER, variantGid: null }],
      offers: [
        {
          productGid: OFFER,
          variantGid: OFFER_VARIANT,
          defaultQuantity: 1,
          minQuantity: 1,
          maxQuantity: 5,
        },
        {
          productGid: OFFER_B,
          variantGid: OFFER_B_VARIANT,
          defaultQuantity: 1,
          minQuantity: 1,
          maxQuantity: 5,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { in: [shopA.id, shopB.id] } } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("delivers offers by default without the checkout switch", async () => {
    const settings = await prisma.shopSettings.findUniqueOrThrow({
      where: { shopId: shopA.id },
    });
    expect(settings.enabled).toBe(false);

    const result = await getStorefrontRecommendations(shopA.id, {
      surface: "PRODUCT_PAGE",
      cart: cartLine(),
    });

    expect(result.enabled).toBe(true);
    expect(result.heading).toBe("Complete your pair");
    expect(result.offers).toHaveLength(2);
  });

  it("returns snapshot-backed offer data", async () => {
    const result = await getStorefrontRecommendations(shopA.id, {
      surface: "PRODUCT_PAGE",
      cart: cartLine(),
    });

    expect(result.offers[0]).toMatchObject({
      variantGid: OFFER_VARIANT,
      productTitle: "Shoe care kit",
      variantTitle: "Standard",
      price: "19.00",
      compareAtPrice: "25.00",
      currencyCode: "USD",
      handle: "shoe-care-kit",
    });
  });

  it("respects the shop offer cap", async () => {
    await updateSettings(shopA.id, {
      ...DEFAULT_SETTINGS,
      enabled: true,
      maxOffers: 1,
    });

    const result = await getStorefrontRecommendations(shopA.id, {
      surface: "PRODUCT_PAGE",
      cart: cartLine(),
    });

    expect(result.offers).toHaveLength(1);

    await updateSettings(shopA.id, { ...DEFAULT_SETTINGS, enabled: true, maxOffers: 3 });
  });

  it("respects per-rule surface toggles", async () => {
    const result = await getStorefrontRecommendations(shopA.id, {
      surface: "CART_PAGE",
      cart: cartLine(),
    });

    expect(result.offers).toHaveLength(0);
  });

  it("does not leak rules across shops", async () => {
    const result = await getStorefrontRecommendations(shopB.id, {
      surface: "PRODUCT_PAGE",
      cart: cartLine(),
    });

    expect(result.offers).toHaveLength(0);
  });

  it("stops returning offers when the rule is paused", async () => {
    const [rule] = await prisma.recommendationRule.findMany({ where: { shopId: shopA.id } });
    await setRuleStatus(shopA.id, rule.id, "PAUSED");

    const result = await getStorefrontRecommendations(shopA.id, {
      surface: "PRODUCT_PAGE",
      cart: cartLine(),
    });
    expect(result.offers).toHaveLength(0);

    await setRuleStatus(shopA.id, rule.id, "ACTIVE");
  });

  it("turns each storefront placement off independently", async () => {
    await updateSettings(shopA.id, {
      ...DEFAULT_SETTINGS,
      enabled: true,
      productPageEnabled: false,
    });

    const product = await getStorefrontRecommendations(shopA.id, {
      surface: "PRODUCT_PAGE",
      cart: cartLine(),
    });
    expect(product.enabled).toBe(false);
    expect(product.offers).toHaveLength(0);

    const cart = await getStorefrontRecommendations(shopA.id, {
      surface: "CART_PAGE",
      cart: cartLine(),
    });
    expect(cart.enabled).toBe(true);

    await updateSettings(shopA.id, { ...DEFAULT_SETTINGS, enabled: true });
  });
});

describe("storefront input parsing", () => {
  it("keeps valid lines and drops malformed ones", () => {
    const lines = parseCartLines(
      JSON.stringify([
        { productGid: TRIGGER, variantGid: OFFER_VARIANT, quantity: 2 },
        { productGid: "not-a-gid", variantGid: "", quantity: 1 },
        { productGid: TRIGGER, variantGid: null, quantity: 0 },
        { productGid: TRIGGER, variantGid: null, quantity: "many" },
      ]),
    );

    expect(lines).toEqual([{ productGid: TRIGGER, variantGid: OFFER_VARIANT, quantity: 2 }]);
  });

  it("returns an empty list for junk input instead of throwing", () => {
    expect(parseCartLines(null)).toEqual([]);
    expect(parseCartLines("not json")).toEqual([]);
    expect(parseCartLines(JSON.stringify({ productGid: TRIGGER }))).toEqual([]);
  });

  it("maps surface names", () => {
    expect(parseSurface("product")).toBe("PRODUCT_PAGE");
    expect(parseSurface("cart")).toBe("CART_PAGE");
    expect(parseSurface("checkout")).toBeNull();
  });
});
