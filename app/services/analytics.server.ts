import { Prisma } from "@prisma/client";
import db from "../db.server";
import type { IncomingEvent } from "../utils/analytics-input";

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
  addAttempts: number;
  adds: number;
  addFailures: number;
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

  const offerIds = [...new Set(events.map((event) => event.offerId))];
  const offers = await db.recommendedProduct.findMany({
    where: { id: { in: offerIds }, shopId },
    select: { id: true, ruleId: true, productGid: true, variantGid: true },
  });
  const offerById = new Map(offers.map((offer) => [offer.id, offer]));

  const now = new Date();
  const rows: Prisma.AnalyticsEventCreateManyInput[] = [];

  for (const event of events) {
    const offer = offerById.get(event.offerId);
    if (!offer) continue;

    rows.push({
      shopId,
      ruleId: offer.ruleId,
      eventType: event.eventType,
      surface: event.surface,
      offerProductGid: offer.productGid,
      offerVariantGid: offer.variantGid,
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
    addAttempts: count("ADD_ATTEMPT"),
    adds,
    addFailures: count("ADD_FAILURE"),
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
