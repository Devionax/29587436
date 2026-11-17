import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import {
  getAnalyticsSummary,
  getRulePerformance,
  recordStorefrontEvents,
} from "../../app/services/analytics.server";
import {
  attributeOrder,
  attributedOrderFromWebhook,
} from "../../app/services/attribution.server";
import { createRule } from "../../app/services/rules.server";
import type { RuleDetail } from "../../app/services/rules.server";
import { createShop, prisma } from "../helpers/db";

const SESSION = "test-session-0123456789";
const OFFER_VARIANT = "gid://shopify/ProductVariant/50201";
const SECOND_VARIANT = "gid://shopify/ProductVariant/50301";

function event(offerId: string, eventType: "IMPRESSION" | "ADD_SUCCESS", key: string) {
  return {
    eventType,
    surface: "PRODUCT_PAGE" as const,
    experience: null,
    declineReason: null,
    offerId,
    sessionKey: SESSION,
    dedupeKey: key,
  };
}

function orderPayload(offerId: string, variantId: number, quantity = 2) {
  return {
    admin_graphql_api_id: "gid://shopify/Order/9001",
    currency: "USD",
    email: "buyer@example.com",
    customer: { email: "buyer@example.com" },
    line_items: [
      {
        product_id: 502,
        variant_id: variantId,
        quantity,
        price: "19.00",
        properties: [
          { name: "_scu_offer", value: offerId },
          { name: "_scu_rule", value: "ignored" },
        ],
      },
    ],
  };
}

describe("analytics ingestion and order attribution", () => {
  let shopA: Awaited<ReturnType<typeof createShop>>;
  let shopB: Awaited<ReturnType<typeof createShop>>;
  let ruleA: RuleDetail;
  let offerA: string;
  let offerA2: string;
  let foreignOffer: string;

  beforeAll(async () => {
    shopA = await createShop("analytics-a");
    shopB = await createShop("analytics-b");

    ruleA = await createRule(shopA.id, {
      name: "Analytics rule",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      showOnProductPage: true,
      showOnCartPage: true,
      triggers: [{ productGid: "gid://shopify/Product/501" }],
      offers: [
        { productGid: "gid://shopify/Product/502", variantGid: OFFER_VARIANT },
        { productGid: "gid://shopify/Product/503", variantGid: SECOND_VARIANT },
      ],
    });
    offerA = ruleA.offers[0]!.id;
    offerA2 = ruleA.offers[1]!.id;

    const ruleB = await createRule(shopB.id, {
      name: "Other shop rule",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      triggers: [{ productGid: "gid://shopify/Product/901" }],
      offers: [
        { productGid: "gid://shopify/Product/902", variantGid: "gid://shopify/ProductVariant/90201" },
      ],
    });
    foreignOffer = ruleB.offers[0]!.id;
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { in: [shopA.id, shopB.id] } } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("records valid events once and skips duplicates", async () => {
    const events = [
      event(offerA, "IMPRESSION", `${SESSION}:impression:1`),
      event(offerA, "ADD_SUCCESS", `${SESSION}:add:1`),
    ];

    expect(await recordStorefrontEvents(shopA.id, events)).toBe(2);
    expect(await recordStorefrontEvents(shopA.id, events)).toBe(0);
  });

  it("ignores events that reference another shop's offer", async () => {
    const inserted = await recordStorefrontEvents(shopA.id, [
      event(foreignOffer, "IMPRESSION", `${SESSION}:impression:foreign`),
    ]);

    expect(inserted).toBe(0);
    expect(
      await prisma.analyticsEvent.count({
        where: { shopId: shopA.id, offerVariantGid: "gid://shopify/ProductVariant/90201" },
      }),
    ).toBe(0);
  });

  it("namespaces dedupe keys per shop", async () => {
    const key = `${SESSION}:impression:shared`;

    await recordStorefrontEvents(shopA.id, [event(offerA, "IMPRESSION", key)]);

    const stored = await prisma.analyticsEvent.findFirstOrThrow({
      where: { shopId: shopA.id },
      orderBy: { receivedAt: "desc" },
      select: { dedupeKey: true },
    });
    expect(stored.dedupeKey.startsWith(shopA.id)).toBe(true);
  });

  it("summarizes per shop without leaking counts", async () => {
    const summary = await getAnalyticsSummary(shopA.id);
    expect(summary.impressions).toBe(2);
    expect(summary.adds).toBe(1);
    expect(summary.attributedOrders).toBe(0);

    const other = await getAnalyticsSummary(shopB.id);
    expect(other.impressions).toBe(0);
    expect(other.addAttempts).toBe(0);
  });

  it("stores the checkout experience and decline reason as dimensions", async () => {
    const inserted = await recordStorefrontEvents(shopA.id, [
      {
        eventType: "OFFER_DECLINED",
        surface: "CHECKOUT",
        experience: "POST_PURCHASE",
        declineReason: "OUT_OF_STOCK",
        offerId: offerA,
        sessionKey: SESSION,
        dedupeKey: `${SESSION}:declined:1`,
      },
      {
        eventType: "OFFER_ACCEPTED",
        surface: "CHECKOUT",
        experience: "PRE_PURCHASE",
        declineReason: null,
        offerId: offerA2,
        sessionKey: SESSION,
        dedupeKey: `${SESSION}:accepted:1`,
      },
    ]);

    expect(inserted).toBe(2);

    const declined = await prisma.analyticsEvent.findFirstOrThrow({
      where: { shopId: shopA.id, dedupeKey: `${shopA.id}:${SESSION}:declined:1` },
    });
    expect(declined.experience).toBe("POST_PURCHASE");
    expect(declined.declineReason).toBe("OUT_OF_STOCK");

    // Rows written before experiences existed keep a null dimension.
    const legacy = await prisma.analyticsEvent.findFirstOrThrow({
      where: { shopId: shopA.id, dedupeKey: `${shopA.id}:${SESSION}:impression:1` },
    });
    expect(legacy.experience).toBeNull();
    expect(legacy.declineReason).toBeNull();

    const otherShop = await prisma.analyticsEvent.count({
      where: { shopId: shopB.id },
    });
    expect(otherShop).toBe(0);
  });

  it("parses an order that carries an offer marker", () => {
    const parsed = attributedOrderFromWebhook(orderPayload(offerA, 50201));

    expect(parsed).toEqual({
      orderGid: "gid://shopify/Order/9001",
      currencyCode: "USD",
      lines: [
        {
          offerId: offerA,
          productGid: "gid://shopify/Product/502",
          variantGid: OFFER_VARIANT,
          quantity: 2,
          price: "19.00",
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("buyer@example.com");
  });

  it("ignores orders without a marker", () => {
    const payload = orderPayload(offerA, 50201);
    (payload.line_items[0] as Record<string, unknown>).properties = [];

    expect(attributedOrderFromWebhook(payload)).toBeNull();
    expect(attributedOrderFromWebhook({})).toBeNull();
  });

  it("credits a tagged order once", async () => {
    const order = attributedOrderFromWebhook(orderPayload(offerA, 50201));
    expect(order).not.toBeNull();

    expect(await attributeOrder(shopA.id, order!)).toBe(1);
    expect(await attributeOrder(shopA.id, order!)).toBe(0);

    const row = await prisma.orderAttribution.findFirstOrThrow({
      where: { shopId: shopA.id, orderGid: "gid://shopify/Order/9001" },
    });
    expect(row.offerVariantGid).toBe(OFFER_VARIANT);
    expect(row.ruleId).toBe(ruleA.id);
    expect(row.quantity).toBe(2);
    expect(row.lineSubtotal.toFixed(2)).toBe("38.00");
    expect(row.currencyCode).toBe("USD");
  });

  it("credits several offers from one order", async () => {
    const payload = orderPayload(offerA2, 50301, 1);
    payload.admin_graphql_api_id = "gid://shopify/Order/9002";
    payload.line_items.push({
      product_id: 502,
      variant_id: 50201,
      quantity: 1,
      price: "19.00",
      properties: [{ name: "_scu_offer", value: offerA }],
    });

    const order = attributedOrderFromWebhook(payload);
    expect(order).not.toBeNull();
    expect(await attributeOrder(shopA.id, order!)).toBe(2);
  });

  it("does not credit a foreign offer or a mismatched variant", async () => {
    const foreign = orderPayload(foreignOffer, 90201);
    foreign.admin_graphql_api_id = "gid://shopify/Order/9003";
    expect(await attributeOrder(shopA.id, attributedOrderFromWebhook(foreign)!)).toBe(0);

    // Marker written by another app for this variant must match the offer it names.
    const mismatched = orderPayload(offerA, 50301);
    mismatched.admin_graphql_api_id = "gid://shopify/Order/9004";
    expect(
      await attributeOrder(shopA.id, attributedOrderFromWebhook(mismatched)!),
    ).toBe(0);
  });

  it("reports attributed totals and the latest currency", async () => {
    const summary = await getAnalyticsSummary(shopA.id);

    expect(summary.attributedOrders).toBe(2);
    expect(summary.attributedUnits).toBe(4);
    expect(summary.attributedRevenue).toBe("76.00");
    expect(summary.attributedCurrency).toBe("USD");
  });

  it("lists top offers with snapshot titles when available", async () => {
    const summary = await getAnalyticsSummary(shopA.id);
    expect(summary.topOffers[0]).toMatchObject({ productGid: "gid://shopify/Product/502" });
    expect(summary.topOffers[0]?.title).toBeNull();
    expect(summary.topOffers[0]?.adds).toBe(1);
  });

  it("records automatic offers only for a rule the shop owns", async () => {
    const autoOffer = `auto:${ruleA.id}:502:50201`;

    expect(
      await recordStorefrontEvents(shopA.id, [
        event(autoOffer, "IMPRESSION", `${SESSION}:auto:owned`),
      ]),
    ).toBe(1);

    const stored = await prisma.analyticsEvent.findFirstOrThrow({
      where: { shopId: shopA.id, dedupeKey: `${shopA.id}:${SESSION}:auto:owned` },
    });
    expect(stored.ruleId).toBe(ruleA.id);
    expect(stored.offerProductGid).toBe("gid://shopify/Product/502");
    expect(stored.offerVariantGid).toBe(OFFER_VARIANT);

    expect(
      await recordStorefrontEvents(shopA.id, [
        event("auto:foreign-rule-id:502:50201", "IMPRESSION", `${SESSION}:auto:foreign`),
      ]),
    ).toBe(0);
  });

  it("attributes automatic offers by rule, product and variant", async () => {
    const autoOffer = `auto:${ruleA.id}:502:50201`;

    const owned = orderPayload(autoOffer, 50201, 1);
    owned.admin_graphql_api_id = "gid://shopify/Order/9005";
    expect(await attributeOrder(shopA.id, attributedOrderFromWebhook(owned)!)).toBe(1);

    const wrongProduct = orderPayload(autoOffer, 50201, 1);
    wrongProduct.admin_graphql_api_id = "gid://shopify/Order/9006";
    (wrongProduct.line_items[0] as Record<string, unknown>).product_id = 999;
    expect(
      await attributeOrder(shopA.id, attributedOrderFromWebhook(wrongProduct)!),
    ).toBe(0);

    const foreignRule = orderPayload("auto:foreign-rule-id:502:50201", 50201, 1);
    foreignRule.admin_graphql_api_id = "gid://shopify/Order/9007";
    expect(
      await attributeOrder(shopA.id, attributedOrderFromWebhook(foreignRule)!),
    ).toBe(0);
  });

  it("aggregates per-offer performance for the offer pages", async () => {
    const performance = await getRulePerformance(shopA.id);
    const stats = performance.get(ruleA.id);

    expect(stats).toBeDefined();
    expect(stats!.impressions).toBeGreaterThanOrEqual(1);
    expect(stats!.adds).toBeGreaterThanOrEqual(1);
    expect(stats!.attributedRevenue).toBe("95.00");
    expect(performance.get("not-a-rule")).toBeUndefined();
  });
});
