import { Prisma } from "@prisma/client";
import db from "../db.server";
import type { IncomingEvent } from "../utils/analytics-input";
import { parseSyntheticOfferId } from "../utils/offer-id";

/**
 * Storefront analytics.
 *
 * Events are attributed to an offer only if that offer belongs to the verified
 * shop, so a forged payload cannot write rows for another tenant. Dedupe keys are
 * namespaced by shop because the unique index is global.
 */

const DEFAULT_WINDOW_DAYS = 30;
const TOP_OFFERS = 5;

export type AnalyticsSummary = {
  windowDays: number;
  impressions: number;
  clicks: number;
  addAttempts: number;
  adds: number;
  addFailures: number;
  /** Post-purchase changesets Shopify applied to the order. */
  orderAccepts: number;
  /** Buyers who continued past a post-purchase offer without accepting it. */
  offerDeclines: number;
  /** Successful adds divided by impressions, or null when nothing was shown. */
  addRate: number | null;
  attributedOrders: number;
  attributedUnits: number;
  attributedRevenue: string | null;
  attributedCurrency: string | null;
  topOffers: {
    productGid: string;
    variantGid: string;
    title: string | null;
    adds: number;
  }[];
};

export async function recordStorefrontEvents(
  shopId: string,
  events: IncomingEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const regularOfferIds = events
    .filter((event) => !parseSyntheticOfferId(event.offerId))
    .map((event) => event.offerId);
  const autoRuleIds = [
    ...new Set(
      events
        .map((event) => parseSyntheticOfferId(event.offerId)?.ruleId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const [offers, ownedAutoRules] = await Promise.all([
    regularOfferIds.length
      ? db.recommendedProduct.findMany({
          where: { id: { in: regularOfferIds }, shopId },
          select: { id: true, ruleId: true, productGid: true, variantGid: true },
        })
      : [],
    autoRuleIds.length
      ? db.recommendationRule.findMany({
          where: { id: { in: autoRuleIds }, shopId },
          select: { id: true },
        })
      : [],
  ]);
  const offerById = new Map(offers.map((offer) => [offer.id, offer]));
  const autoRuleIdSet = new Set(ownedAutoRules.map((rule) => rule.id));

  const now = new Date();
  const rows: Prisma.AnalyticsEventCreateManyInput[] = [];

  for (const event of events) {
    const offer = offerById.get(event.offerId);
    if (offer) {
      rows.push({
        shopId,
        ruleId: offer.ruleId,
        eventType: event.eventType,
        surface: event.surface,
        experience: event.experience,
        declineReason: event.declineReason,
        offerProductGid: offer.productGid,
        offerVariantGid: offer.variantGid,
        sessionKey: event.sessionKey,
        dedupeKey: `${shopId}:${event.dedupeKey}`,
        occurredAt: now,
      });
      continue;
    }

    // Automatic offers have no row; the id embeds the rule and product, and the
    // rule must still belong to this shop before anything is written.
    const auto = parseSyntheticOfferId(event.offerId);
    if (!auto || !autoRuleIdSet.has(auto.ruleId)) continue;

    rows.push({
      shopId,
      ruleId: auto.ruleId,
      eventType: event.eventType,
      surface: event.surface,
      experience: event.experience,
      declineReason: event.declineReason,
      offerProductGid: auto.productGid,
      offerVariantGid: auto.variantGid,
      sessionKey: event.sessionKey,
      dedupeKey: `${shopId}:${event.dedupeKey}`,
      occurredAt: now,
    });
  }

  if (rows.length === 0) return 0;

  const result = await db.analyticsEvent.createMany({
    data: rows,
    skipDuplicates: true,
  });

  return result.count;
}

function windowStart(days: number): Date {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export async function getAnalyticsSummary(
  shopId: string,
  days = DEFAULT_WINDOW_DAYS,
): Promise<AnalyticsSummary> {
  const since = windowStart(days);

  const [counts, topAdds, attribution, attributedOrders, currencyRow] =
    await Promise.all([
      db.analyticsEvent.groupBy({
        by: ["eventType"],
        where: { shopId, receivedAt: { gte: since } },
        _count: { _all: true },
      }),
      db.analyticsEvent.groupBy({
        by: ["offerProductGid", "offerVariantGid"],
        where: { shopId, eventType: "ADD_SUCCESS", receivedAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { offerProductGid: "desc" } },
        take: TOP_OFFERS,
      }),
      db.orderAttribution.aggregate({
        where: { shopId, attributedAt: { gte: since } },
        _sum: { quantity: true, lineSubtotal: true },
      }),
      db.orderAttribution.groupBy({
        by: ["orderGid"],
        where: { shopId, attributedAt: { gte: since } },
      }),
      db.orderAttribution.findFirst({
        where: { shopId, attributedAt: { gte: since } },
        orderBy: { attributedAt: "desc" },
        select: { currencyCode: true },
      }),
    ]);

  const count = (eventType: string) =>
    counts.find((row) => row.eventType === eventType)?._count._all ?? 0;

  const productGids = topAdds.map((row) => row.offerProductGid);
  const snapshots = productGids.length
    ? await db.productSnapshot.findMany({
        where: { shopId, productGid: { in: productGids } },
        select: { productGid: true, title: true },
      })
    : [];
  const titleByGid = new Map(snapshots.map((row) => [row.productGid, row.title]));

  const impressions = count("IMPRESSION");
  const adds = count("ADD_SUCCESS");

  return {
    windowDays: days,
    impressions,
    clicks: count("CLICK"),
    addAttempts: count("ADD_ATTEMPT"),
    adds,
    addFailures: count("ADD_FAILURE"),
    orderAccepts: count("OFFER_ACCEPTED"),
    offerDeclines: count("OFFER_DECLINED"),
    addRate: impressions > 0 ? Math.round((adds / impressions) * 1000) / 10 : null,
    attributedOrders: attributedOrders.length,
    attributedUnits: attribution._sum.quantity ?? 0,
    attributedRevenue: attribution._sum.lineSubtotal
      ? attribution._sum.lineSubtotal.toFixed(2)
      : null,
    attributedCurrency: currencyRow?.currencyCode ?? null,
    topOffers: topAdds.map((row) => ({
      productGid: row.offerProductGid,
      variantGid: row.offerVariantGid ?? "",
      title: titleByGid.get(row.offerProductGid) ?? null,
      adds: row._count._all,
    })),
  };
}

export type RulePerformance = {
  impressions: number;
  clicks: number;
  addAttempts: number;
  adds: number;
  addFailures: number;
  /** Post-purchase changesets applied for this offer. */
  accepts: number;
  attributedUnits: number;
  attributedRevenue: string | null;
};

const EMPTY_PERFORMANCE: RulePerformance = {
  impressions: 0,
  clicks: 0,
  addAttempts: 0,
  adds: 0,
  addFailures: 0,
  accepts: 0,
  attributedUnits: 0,
  attributedRevenue: null,
};

/**
 * Per-offer performance for the offer table, dashboard and analytics page.
 * Offers without events are absent from the map; callers default to zero.
 */
export async function getRulePerformance(
  shopId: string,
  days = DEFAULT_WINDOW_DAYS,
): Promise<Map<string, RulePerformance>> {
  const since = windowStart(days);

  const [events, attribution] = await Promise.all([
    db.analyticsEvent.groupBy({
      by: ["ruleId", "eventType"],
      where: { shopId, ruleId: { not: null }, receivedAt: { gte: since } },
      _count: { _all: true },
    }),
    db.orderAttribution.groupBy({
      by: ["ruleId"],
      where: { shopId, ruleId: { not: null }, attributedAt: { gte: since } },
      _sum: { quantity: true, lineSubtotal: true },
    }),
  ]);

  const performance = new Map<string, RulePerformance>();

  const row = (ruleId: string): RulePerformance => {
    const existing = performance.get(ruleId);
    if (existing) return existing;
    const created = { ...EMPTY_PERFORMANCE };
    performance.set(ruleId, created);
    return created;
  };

  for (const event of events) {
    if (!event.ruleId) continue;
    const target = row(event.ruleId);
    switch (event.eventType) {
      case "IMPRESSION":
        target.impressions += event._count._all;
        break;
      case "CLICK":
        target.clicks += event._count._all;
        break;
      case "ADD_ATTEMPT":
        target.addAttempts += event._count._all;
        break;
      case "ADD_SUCCESS":
        target.adds += event._count._all;
        break;
      case "ADD_FAILURE":
        target.addFailures += event._count._all;
        break;
      case "OFFER_ACCEPTED":
        target.accepts += event._count._all;
        break;
      default:
        break;
    }
  }

  for (const entry of attribution) {
    if (!entry.ruleId) continue;
    const target = row(entry.ruleId);
    target.attributedUnits += entry._sum.quantity ?? 0;
    const revenue = entry._sum.lineSubtotal;
    target.attributedRevenue = revenue ? revenue.toFixed(2) : null;
  }

  return performance;
}
