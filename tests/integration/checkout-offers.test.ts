import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getCheckoutOffers } from "../../app/services/checkout-offers.server";
import type { CheckoutContext } from "../../app/services/checkout-offers.server";
import { upsertProductSnapshot } from "../../app/services/catalog.server";
import type { CatalogProduct } from "../../app/services/catalog.server";
import { createCondition, createConditionGroup } from "../../app/services/conditions.server";
import { createRule } from "../../app/services/rules.server";
import { DEFAULT_SETTINGS, updateSettings } from "../../app/services/settings.server";
import { createShop, prisma } from "../helpers/db";

/**
 * Evaluation tests for the service both checkout experiences share. Every test
 * gets its own tenant so rules and snapshots cannot leak between cases.
 */

const shops: string[] = [];

function product(id: number, options: { available?: boolean; status?: string } = {}): CatalogProduct {
  const available = options.available ?? true;
  return {
    productGid: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    handle: `product-${id}`,
    status: options.status ?? "ACTIVE",
    imageUrl: null,
    availableForSale: available,
    priceMin: "10.00",
    priceMax: "12.00",
    currencyCode: "USD",
    variants: [
      {
        variantGid: `gid://shopify/ProductVariant/${id * 100 + 1}`,
        title: "Default",
        price: id === 702 ? "12.00" : "10.00",
        compareAtPrice: null,
        availableForSale: available,
        position: 0,
      },
    ],
  };
}

function variantOf(id: number): string {
  return `gid://shopify/ProductVariant/${id * 100 + 1}`;
}

async function plusShop(suffix: string) {
  const shop = await createShop(suffix);
  shops.push(shop.id);
  await prisma.shop.update({ where: { id: shop.id }, data: { isPlus: true } });
  await updateSettings(shop.id, { ...DEFAULT_SETTINGS, enabled: true });
  return { id: shop.id, isPlus: true, ianaTimezone: shop.ianaTimezone };
}

function offered(triggerId: number, offerId: number) {
  return {
    name: `Offer ${triggerId} to ${offerId}`,
    status: "ACTIVE" as const,
    priority: 10,
    matchMode: "ANY" as const,
    heading: "Pairs well with",
    triggers: [{ productGid: `gid://shopify/Product/${triggerId}` }],
    offers: [
      {
        productGid: `gid://shopify/Product/${offerId}`,
        variantGid: variantOf(offerId),
      },
    ],
    experiences: [
      {
        experience: "PRE_PURCHASE" as const,
        enabled: true,
        headline: null,
        body: null,
        ctaLabel: null,
      },
    ],
  };
}

function cartWith(productId: number, quantity = 1): CheckoutContext {
  return {
    lines: [
      {
        productGid: `gid://shopify/Product/${productId}`,
        variantGid: variantOf(productId),
        quantity,
      },
    ],
    subtotal: 100,
    customerLoggedIn: true,
    marketCountry: "US",
  };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  delete process.env.POST_PURCHASE_ENABLED;
  if (shops.length > 0) {
    await prisma.shop.deleteMany({ where: { id: { in: shops.splice(0) } } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("getCheckoutOffers — pre-purchase", () => {
  it("returns nothing until the merchant enables delivery", async () => {
    const shop = await createShop("checkout-disabled");
    shops.push(shop.id);

    const result = await getCheckoutOffers(
      { id: shop.id, isPlus: true, ianaTimezone: null },
      "PRE_PURCHASE",
      cartWith(701),
    );

    expect(result).toEqual({ enabled: false, heading: null, offers: [] });
  });

  it("is unavailable on a non-Plus store even when a rule matches", async () => {
    const shop = await createShop("checkout-non-plus");
    shops.push(shop.id);
    await updateSettings(shop.id, { ...DEFAULT_SETTINGS, enabled: true });
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    await createRule(shop.id, offered(701, 702));

    const result = await getCheckoutOffers(
      { id: shop.id, isPlus: false, ianaTimezone: null },
      "PRE_PURCHASE",
      cartWith(701),
    );

    expect(result.enabled).toBe(false);
    expect(result.offers).toHaveLength(0);
  });

  it("returns a matching manual offer with server-side price and copy", async () => {
    const shop = await plusShop("checkout-basic");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    const rule = await createRule(shop.id, {
      ...offered(701, 702),
      description: "A useful add-on",
    });

    const result = await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701));

    expect(result.enabled).toBe(true);
    expect(result.heading).toBe("Pairs well with");
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]).toMatchObject({
      id: rule.offers[0].id,
      productGid: "gid://shopify/Product/702",
      variantGid: variantOf(702),
      productTitle: "Product 702",
      price: "12",
      currencyCode: "USD",
      quantity: 1,
      headline: "Pairs well with",
      body: "A useful add-on",
      ctaLabel: "Add to cart",
    });
  });

  it("prefers per-experience copy and falls back to a default CTA", async () => {
    const shop = await plusShop("checkout-copy");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    await createRule(shop.id, {
      ...offered(701, 702),
      experiences: [
        {
          experience: "PRE_PURCHASE",
          enabled: true,
          headline: "Grab this",
          body: "Because it fits",
          ctaLabel: "Add the refill",
        },
      ],
    });

    const result = await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701));

    expect(result.offers[0]).toMatchObject({
      headline: "Grab this",
      body: "Because it fits",
      ctaLabel: "Add the refill",
    });
  });

  it("requires every trigger when the rule matches ALL", async () => {
    const shop = await plusShop("checkout-all");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(703));
    await upsertProductSnapshot(shop.id, product(702));
    await createRule(shop.id, {
      ...offered(701, 702),
      matchMode: "ALL",
      triggers: [
        { productGid: "gid://shopify/Product/701" },
        { productGid: "gid://shopify/Product/703" },
      ],
    });

    const onlyOne = await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701));
    expect(onlyOne.offers).toHaveLength(0);

    const both = await getCheckoutOffers(shop, "PRE_PURCHASE", {
      ...cartWith(701),
      lines: [
        ...cartWith(701).lines,
        {
          productGid: "gid://shopify/Product/703",
          variantGid: variantOf(703),
          quantity: 1,
        },
      ],
    });
    expect(both.offers).toHaveLength(1);
  });

  it("applies condition groups and fails closed on unknown data", async () => {
    const shop = await plusShop("checkout-conditions");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    const rule = await createRule(shop.id, offered(701, 702));
    const group = await createConditionGroup(shop.id, rule.id);
    await createCondition(shop.id, rule.id, group.id, {
      field: "CART_SUBTOTAL",
      operator: "GT",
      value: 50,
    });

    const passes = await getCheckoutOffers(shop, "PRE_PURCHASE", {
      ...cartWith(701),
      subtotal: 60,
    });
    expect(passes.offers).toHaveLength(1);

    const fails = await getCheckoutOffers(shop, "PRE_PURCHASE", {
      ...cartWith(701),
      subtotal: 40,
    });
    expect(fails.offers).toHaveLength(0);

    const unknown = await getCheckoutOffers(shop, "PRE_PURCHASE", {
      ...cartWith(701),
      subtotal: null,
    });
    expect(unknown.offers).toHaveLength(0);
  });

  it("does not offer a variant that is already in the cart", async () => {
    const shop = await plusShop("checkout-in-cart");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    await createRule(shop.id, offered(701, 702));

    const result = await getCheckoutOffers(shop, "PRE_PURCHASE", {
      ...cartWith(701),
      lines: [
        ...cartWith(701).lines,
        {
          productGid: "gid://shopify/Product/702",
          variantGid: variantOf(702),
          quantity: 1,
        },
      ],
    });

    expect(result.offers).toHaveLength(0);
  });

  it("skips offers without a snapshot or with an unavailable variant", async () => {
    const shop = await plusShop("checkout-unavailable");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702, { available: false }));
    await createRule(shop.id, offered(701, 702));
    await createRule(shop.id, {
      ...offered(701, 704),
      name: "Offer without snapshot",
    });

    const result = await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701));
    expect(result.offers).toHaveLength(0);
  });

  it("deduplicates products across rules and keeps priority order", async () => {
    const shop = await plusShop("checkout-dedupe");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    await upsertProductSnapshot(shop.id, product(703));

    const lower = await createRule(shop.id, {
      ...offered(701, 702),
      name: "Low priority",
      priority: 20,
      heading: "Second",
    });
    const higher = await createRule(shop.id, {
      ...offered(701, 702),
      name: "High priority",
      priority: 5,
      heading: "First",
    });
    await createRule(shop.id, {
      ...offered(701, 703),
      name: "Other product",
      priority: 30,
      heading: "Third",
    });

    const result = await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701));

    expect(result.offers.map((offer) => offer.productGid)).toEqual([
      "gid://shopify/Product/702",
      "gid://shopify/Product/703",
    ]);
    expect(result.offers[0].id).toBe(higher.offers[0].id);
    expect(result.offers[0].id).not.toBe(lower.offers[0].id);
    expect(result.heading).toBe("First");
  });

  it("honours the shop-level and per-rule offer caps", async () => {
    const shop = await plusShop("checkout-caps");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    await upsertProductSnapshot(shop.id, product(703));
    await updateSettings(shop.id, {
      ...DEFAULT_SETTINGS,
      enabled: true,
      maxOffers: 1,
    });

    await createRule(shop.id, { ...offered(701, 702), priority: 1 });
    await createRule(shop.id, { ...offered(701, 703), priority: 2 });

    const result = await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701));
    expect(result.offers).toHaveLength(1);

    await upsertProductSnapshot(shop.id, product(704));
    await upsertProductSnapshot(shop.id, product(705));
    await updateSettings(shop.id, {
      ...DEFAULT_SETTINGS,
      enabled: true,
      maxOffers: 5,
    });
    const capped = await createRule(shop.id, {
      ...offered(701, 704),
      name: "Rule cap",
      priority: 0,
      maxOffers: 1,
      offers: [
        {
          productGid: "gid://shopify/Product/704",
          variantGid: variantOf(704),
        },
        {
          productGid: "gid://shopify/Product/705",
          variantGid: variantOf(705),
        },
      ],
    });

    // The capped rule contributes one offer; the other two rules contribute
    // theirs, so the cap is per rule and the shop cap is still respected.
    const cappedResult = await getCheckoutOffers(
      shop,
      "PRE_PURCHASE",
      cartWith(701),
    );
    expect(cappedResult.offers).toHaveLength(3);
    expect(cappedResult.offers[0].id).toBe(capped.offers[0].id);
  });

  it("respects the schedule window", async () => {
    const shop = await plusShop("checkout-schedule");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));

    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await createRule(shop.id, { ...offered(701, 702), startsAt: soon });
    expect(
      (await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701))).offers,
    ).toHaveLength(0);

    await prisma.recommendationRule.updateMany({
      where: { shopId: shop.id },
      data: { startsAt: past, endsAt: past },
    });
    expect(
      (await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701))).offers,
    ).toHaveLength(0);

    await prisma.recommendationRule.updateMany({
      where: { shopId: shop.id },
      data: { endsAt: soon },
    });
    expect(
      (await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701))).offers,
    ).toHaveLength(1);
  });

  it("keeps another shop's rules and snapshots out of the result", async () => {
    const shop = await plusShop("checkout-tenant-a");
    const other = await plusShop("checkout-tenant-b");

    await upsertProductSnapshot(other.id, product(701));
    await upsertProductSnapshot(other.id, product(702));
    await createRule(other.id, offered(701, 702));

    const result = await getCheckoutOffers(shop, "PRE_PURCHASE", cartWith(701));
    expect(result.offers).toHaveLength(0);
  });
});

describe("getCheckoutOffers — post-purchase", () => {
  it("stays off until the deployment enables post-purchase", async () => {
    const shop = await plusShop("checkout-post-flag");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    await createRule(shop.id, {
      ...offered(701, 702),
      experiences: [
        {
          experience: "POST_PURCHASE",
          enabled: true,
          headline: null,
          body: null,
          ctaLabel: null,
        },
      ],
    });

    const result = await getCheckoutOffers(shop, "POST_PURCHASE", cartWith(701));
    expect(result.enabled).toBe(false);
    expect(result.offers).toHaveLength(0);
  });

  it("delivers an unconditional offer after any purchase", async () => {
    process.env.POST_PURCHASE_ENABLED = "true";
    const shop = await plusShop("checkout-post-manual");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    await createRule(shop.id, {
      ...offered(701, 702),
      triggers: [],
      sources: ["MANUAL"],
      experiences: [
        {
          experience: "POST_PURCHASE",
          enabled: true,
          headline: null,
          body: null,
          ctaLabel: null,
        },
      ],
    });

    const base: CheckoutContext = {
      lines: cartWith(701).lines,
      orderTotal: 40,
      orderLineCount: 1,
      customerLoggedIn: true,
      shippingCountry: "CA",
    };
    const result = await getCheckoutOffers(shop, "POST_PURCHASE", base);
    expect(result.offers).toHaveLength(1);

    const empty = await getCheckoutOffers(shop, "POST_PURCHASE", {
      ...base,
      lines: [],
    });
    expect(empty.offers).toHaveLength(0);
  });

  it("evaluates order conditions against the completed purchase", async () => {
    process.env.POST_PURCHASE_ENABLED = "true";
    const shop = await plusShop("checkout-post-conditions");
    await upsertProductSnapshot(shop.id, product(701));
    await upsertProductSnapshot(shop.id, product(702));
    const rule = await createRule(shop.id, {
      ...offered(701, 702),
      experiences: [
        {
          experience: "POST_PURCHASE",
          enabled: true,
          headline: "One more thing",
          body: null,
          ctaLabel: null,
        },
      ],
    });
    const group = await createConditionGroup(shop.id, rule.id);
    await createCondition(shop.id, rule.id, group.id, {
      field: "ORDER_TOTAL",
      operator: "GTE",
      value: 50,
    });

    const base: CheckoutContext = {
      lines: cartWith(701).lines,
      orderTotal: 80,
      orderLineCount: 1,
      customerLoggedIn: true,
      shippingCountry: "CA",
    };

    const passes = await getCheckoutOffers(shop, "POST_PURCHASE", base);
    expect(passes.enabled).toBe(true);
    expect(passes.offers[0]).toMatchObject({
      headline: "One more thing",
      ctaLabel: "Add to order",
      quantity: 1,
    });

    const fails = await getCheckoutOffers(shop, "POST_PURCHASE", {
      ...base,
      orderTotal: 40,
    });
    expect(fails.offers).toHaveLength(0);
  });

  it("caps post-purchase offers at three", async () => {
    process.env.POST_PURCHASE_ENABLED = "true";
    const shop = await plusShop("checkout-post-cap");
    for (const id of [701, 702, 703, 704, 705]) {
      await upsertProductSnapshot(shop.id, product(id));
    }
    await updateSettings(shop.id, {
      ...DEFAULT_SETTINGS,
      enabled: true,
      maxOffers: 10,
    });
    await createRule(shop.id, {
      ...offered(701, 702),
      experiences: [
        {
          experience: "POST_PURCHASE",
          enabled: true,
          headline: null,
          body: null,
          ctaLabel: null,
        },
      ],
      offers: [702, 703, 704, 705].map((id) => ({
        productGid: `gid://shopify/Product/${id}`,
        variantGid: variantOf(id),
      })),
    });

    const result = await getCheckoutOffers(shop, "POST_PURCHASE", {
      lines: cartWith(701).lines,
      orderTotal: 80,
      orderLineCount: 1,
      customerLoggedIn: true,
      shippingCountry: "CA",
    });

    expect(result.offers).toHaveLength(3);
  });
});
