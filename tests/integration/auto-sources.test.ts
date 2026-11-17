import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import { upsertProductSnapshot } from "../../app/services/catalog.server";
import type { CatalogProduct } from "../../app/services/catalog.server";
import { getStorefrontRecommendations } from "../../app/services/recommendations.server";
import { createRule, updateRule } from "../../app/services/rules.server";
import type { RuleDetail } from "../../app/services/rules.server";
import { DEFAULT_SETTINGS, updateSettings } from "../../app/services/settings.server";
import { createShop, prisma } from "../helpers/db";

const TRIGGER = "gid://shopify/Product/601";
const REPEATED = "gid://shopify/Product/602";
const REPEATED_VARIANT = "gid://shopify/ProductVariant/60201";
const REMOVED = "gid://shopify/Product/603";
const REMOVED_VARIANT = "gid://shopify/ProductVariant/60301";
const IN_CART = "gid://shopify/Product/604";
const IN_CART_VARIANT = "gid://shopify/ProductVariant/60401";

const CART_TOKEN = "auto-source-cart-token";

function snapshot(productGid: string, variantGid: string, title: string): CatalogProduct {
  return {
    productGid,
    title,
    handle: title.toLowerCase().replace(/\s+/g, "-"),
    status: "ACTIVE",
    imageUrl: null,
    availableForSale: true,
    priceMin: "12.00",
    priceMax: "12.00",
    currencyCode: "USD",
    variants: [
      {
        variantGid,
        title: "Default",
        price: "12.00",
        compareAtPrice: null,
        availableForSale: true,
        position: 0,
      },
    ],
  };
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

describe("automatic recommendation sources", () => {
  let shop: Awaited<ReturnType<typeof createShop>>;
  let rule: RuleDetail;

  beforeAll(async () => {
    shop = await createShop("auto-sources");
    await upsertProductSnapshot(shop.id, snapshot(REPEATED, REPEATED_VARIANT, "Repeat product"));
    await upsertProductSnapshot(shop.id, snapshot(REMOVED, REMOVED_VARIANT, "Removed product"));
    await upsertProductSnapshot(shop.id, snapshot(IN_CART, IN_CART_VARIANT, "Already in cart"));

    await updateSettings(shop.id, { ...DEFAULT_SETTINGS, enabled: true, maxOffers: 5 });

    rule = await createRule(shop.id, {
      name: "Cart-driven",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      heading: "Picked from cart activity",
      showOnProductPage: true,
      showOnCartPage: false,
      sources: ["REPEATED_ACTIVITY", "RECENTLY_REMOVED"],
      autoLookbackHours: 24,
      autoMinRepeats: 2,
      autoMaxOffers: 5,
      triggers: [{ productGid: TRIGGER, variantGid: null }],
      offers: [],
    });

    await prisma.cartActivity.createMany({
      data: [
        {
          shopId: shop.id,
          sessionKey: "other-cart",
          productGid: REPEATED,
          variantGid: REPEATED_VARIANT,
          activityType: "ADDED",
          occurredAt: minutesAgo(30),
        },
        {
          shopId: shop.id,
          sessionKey: "other-cart",
          productGid: REPEATED,
          variantGid: REPEATED_VARIANT,
          activityType: "ADDED",
          occurredAt: minutesAgo(20),
        },
        {
          shopId: shop.id,
          sessionKey: CART_TOKEN,
          productGid: REMOVED,
          variantGid: REMOVED_VARIANT,
          activityType: "REMOVED",
          occurredAt: minutesAgo(10),
        },
        // Same variant removed from the current cart and added twice elsewhere:
        // it must appear once, in the highest-priority source that claims it.
        {
          shopId: shop.id,
          sessionKey: CART_TOKEN,
          productGid: REPEATED,
          variantGid: REPEATED_VARIANT,
          activityType: "REMOVED",
          occurredAt: minutesAgo(5),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.shop.delete({ where: { id: shop.id } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("merges automatic sources in priority order and dedupes variants", async () => {
    const result = await getStorefrontRecommendations(shop.id, {
      surface: "PRODUCT_PAGE",
      cart: [{ productGid: TRIGGER, variantGid: null, quantity: 1 }],
      cartToken: CART_TOKEN,
    });

    expect(result.enabled).toBe(true);
    expect(result.offers.map((offer) => offer.variantGid)).toEqual([
      REPEATED_VARIANT,
      REMOVED_VARIANT,
    ]);
    expect(result.offers[0]?.offerId).toBe(`auto:${rule.id}:602:60201`);
    expect(result.offers[0]?.productTitle).toBe("Repeat product");
    expect(result.offers[0]?.ruleName).toBe("Cart-driven");
  });

  it("never recommends a variant that is already in the cart", async () => {
    const result = await getStorefrontRecommendations(shop.id, {
      surface: "PRODUCT_PAGE",
      cart: [
        { productGid: TRIGGER, variantGid: null, quantity: 1 },
        { productGid: IN_CART, variantGid: IN_CART_VARIANT, quantity: 1 },
      ],
      cartToken: CART_TOKEN,
    });

    expect(result.offers.map((offer) => offer.variantGid)).not.toContain(IN_CART_VARIANT);
  });

  it("ignores activity outside the configured lookback", async () => {
    await prisma.cartActivity.create({
      data: {
        shopId: shop.id,
        sessionKey: CART_TOKEN,
        productGid: IN_CART,
        variantGid: IN_CART_VARIANT,
        activityType: "REMOVED",
        occurredAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
    });

    const result = await getStorefrontRecommendations(shop.id, {
      surface: "PRODUCT_PAGE",
      cart: [{ productGid: TRIGGER, variantGid: null, quantity: 1 }],
      cartToken: CART_TOKEN,
    });

    expect(result.offers.map((offer) => offer.variantGid)).not.toContain(IN_CART_VARIANT);
  });

  it("stops automatic offers while the offer is outside its schedule", async () => {
    const scheduled = await updateRule(shop.id, rule.id, {
      name: rule.name,
      description: rule.description,
      status: rule.status,
      priority: rule.priority,
      matchMode: rule.matchMode,
      heading: rule.heading,
      maxOffers: rule.maxOffers,
      showOnProductPage: rule.showOnProductPage,
      showOnCartPage: rule.showOnCartPage,
      showOnCheckout: rule.showOnCheckout,
      sources: rule.sources,
      autoLookbackHours: rule.autoLookbackHours,
      autoMaxOffers: rule.autoMaxOffers,
      autoMinRepeats: rule.autoMinRepeats,
      prioritizeRepeats: rule.prioritizeRepeats,
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      endsAt: null,
      triggers: rule.triggers.map((trigger) => ({
        productGid: trigger.productGid,
        variantGid: trigger.variantGid || null,
      })),
      offers: [],
    });

    const result = await getStorefrontRecommendations(shop.id, {
      surface: "PRODUCT_PAGE",
      cart: [{ productGid: TRIGGER, variantGid: null, quantity: 1 }],
      cartToken: CART_TOKEN,
    });

    expect(scheduled.startsAt).not.toBeNull();
    expect(result.offers).toHaveLength(0);
  });
});
