import type { Prisma } from "@prisma/client";
import db from "../db.server";
import type {
  CartLine,
  EngineOffer,
  EngineProduct,
  EngineRule,
  RecommendationResult,
  Surface,
} from "./recommendation-engine";
import { recommendOffers } from "./recommendation-engine";
import { loadRecentActivity } from "./cart-activity.server";
import type { ActivityRow } from "./cart-activity.server";
import { DEFAULT_SETTINGS } from "./settings.server";
import { syntheticOfferId } from "../utils/offer-id";
import {
  conditionsMatch,
  type ConditionContext,
} from "../utils/condition-evaluator";
import {
  validateConditionTree,
  type ConditionGroupNode,
} from "../utils/condition-schema";
import { logger, toErrorMessage } from "../utils/logger.server";

/**
 * Loads the shop's offers, product snapshots and cart activity, then runs the
 * pure engine. The caller is responsible for proving the shopId comes from a
 * verified Shopify signature — nothing here reads identity from a request.
 *
 * Conditions are evaluated here, before the engine sees a rule, with the same
 * evaluator checkout uses. Storefront context can be unknown (countries, time
 * zone on an old install); unknown never matches, so a rule cannot sell on data
 * the storefront never had.
 */

export type StorefrontRecommendations = {
  /** False only when the merchant turned this placement off. */
  enabled: boolean;
  heading: string | null;
  offers: RecommendationResult["offers"];
  excluded: RecommendationResult["excluded"];
};

type AutoCandidate = {
  productGid: string;
  variantGid: string;
  lastAt: Date;
  count: number;
};

type ConditionGroupRow = Prisma.OfferConditionGroupGetPayload<{
  include: { conditions: true };
}>;

/** Root rows have no parent; children attach by parent id, preserving order. */
function conditionTree(groups: ConditionGroupRow[]): ConditionGroupNode[] {
  const byParent = new Map<string | null, ConditionGroupRow[]>();

  for (const group of groups) {
    const siblings = byParent.get(group.parentGroupId);
    if (siblings) siblings.push(group);
    else byParent.set(group.parentGroupId, [group]);
  }

  const build = (group: ConditionGroupRow): ConditionGroupNode => ({
    joinOp: group.joinOp,
    conditions: group.conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      valueJson: condition.valueJson,
      position: condition.position,
    })),
    children: (byParent.get(group.id) ?? []).map(build),
  });

  return (byParent.get(null) ?? []).map(build);
}

const AUTO_DEFAULT_QUANTITY = { defaultQuantity: 1, minQuantity: 1, maxQuantity: 10 };

function candidatesForRule(
  activity: ActivityRow[],
  rule: {
    autoLookbackHours: number;
    autoMinRepeats: number;
    prioritizeRepeats: boolean;
  },
  cartToken: string | null,
): { recentlyRemoved: AutoCandidate[]; repeated: AutoCandidate[] } {
  const since = Date.now() - rule.autoLookbackHours * 60 * 60 * 1000;
  const removed = new Map<string, AutoCandidate>();
  const repeats = new Map<string, AutoCandidate>();

  // Activity is newest-first, so the first row per variant is the latest one.
  for (const row of activity) {
    if (row.occurredAt.getTime() < since) continue;
    const key = row.variantGid;

    if (
      cartToken &&
      row.activityType === "REMOVED" &&
      row.sessionKey === cartToken &&
      !removed.has(key)
    ) {
      removed.set(key, {
        productGid: row.productGid,
        variantGid: row.variantGid,
        lastAt: row.occurredAt,
        count: 1,
      });
    }

    if (rule.prioritizeRepeats && row.activityType === "ADDED") {
      const existing = repeats.get(key);
      if (existing) {
        existing.count += 1;
        if (row.occurredAt > existing.lastAt) existing.lastAt = row.occurredAt;
      } else {
        repeats.set(key, {
          productGid: row.productGid,
          variantGid: row.variantGid,
          lastAt: row.occurredAt,
          count: 1,
        });
      }
    }
  }

  const repeated = [...repeats.values()]
    .filter((candidate) => candidate.count >= Math.max(1, rule.autoMinRepeats))
    .sort((a, b) => b.count - a.count || b.lastAt.getTime() - a.lastAt.getTime());

  return {
    recentlyRemoved: [...removed.values()].sort(
      (a, b) => b.lastAt.getTime() - a.lastAt.getTime(),
    ),
    repeated,
  };
}

export async function getStorefrontRecommendations(
  shopId: string,
  options: {
    surface: Surface;
    cart: CartLine[];
    /** Cart subtotal in shop currency, from /cart.js. A hint, never a price. */
    subtotal?: number | null;
    /** Resolved by the theme block; null when the block cannot tell. */
    customerLoggedIn?: boolean | null;
    /** Pseudonymous cart token used by the recently-removed source. */
    cartToken?: string | null;
    /**
     * Product page anchor: the product being viewed. It joins the evaluation
     * cart for trigger and condition matching only; it does not make the real
     * cart non-empty for manual offers.
     */
    viewedProduct?: { productGid: string; variantGid: string | null } | null;
    limit?: number;
  },
): Promise<StorefrontRecommendations> {
  const settings = await db.shopSettings.findUnique({ where: { shopId } });
  const maxOffers = settings?.maxOffers ?? DEFAULT_SETTINGS.maxOffers;
  const defaultHeading = settings?.defaultHeading ?? DEFAULT_SETTINGS.defaultHeading;

  // Storefront placements are independent of the checkout master switch: the
  // setting labeled "show offers in checkout" must not hide product and cart
  // page blocks. Each placement has its own switch, on by default.
  const surfaceField =
    options.surface === "PRODUCT_PAGE" ? "showOnProductPage" : "showOnCartPage";
  const surfaceAllowed =
    options.surface === "PRODUCT_PAGE"
      ? (settings?.productPageEnabled ?? DEFAULT_SETTINGS.productPageEnabled)
      : (settings?.cartPageEnabled ?? DEFAULT_SETTINGS.cartPageEnabled);

  if (!surfaceAllowed) {
    return { enabled: false, heading: null, offers: [], excluded: [] };
  }

  const rules = await db.recommendationRule.findMany({
    where: {
      shopId,
      status: "ACTIVE",
      [surfaceField]: true,
    },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
    include: {
      triggers: { orderBy: { createdAt: "asc" } },
      offers: { orderBy: [{ position: "asc" }, { id: "asc" }] },
      conditionGroups: {
        include: {
          conditions: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });

  const now = new Date();
  const timed = rules.filter(
    (rule) =>
      (!rule.startsAt || rule.startsAt <= now) &&
      (!rule.endsAt || rule.endsAt > now),
  );

  // A product page is evaluated as "the product being viewed is the anchor",
  // which is how trigger and condition matching reach a page the buyer has not
  // added anything from yet. The real cart stays the source of manual-offer
  // eligibility, so those offers still wait for an actual cart item.
  const evaluationCart: CartLine[] = [...options.cart];
  const viewed = options.viewedProduct ?? null;
  if (options.surface === "PRODUCT_PAGE" && viewed) {
    const already = evaluationCart.some((line) =>
      viewed.variantGid
        ? line.variantGid === viewed.variantGid
        : line.productGid === viewed.productGid,
    );
    if (!already) {
      evaluationCart.push({
        productGid: viewed.productGid,
        variantGid: viewed.variantGid,
        quantity: 1,
      });
    }
  }
  const hasCartItems = options.cart.some((line) => line.quantity > 0);

  const shopRow = await db.shop.findUnique({
    where: { id: shopId },
    select: { ianaTimezone: true },
  });
  const conditionContext: ConditionContext = {
    cart: {
      subtotal: options.subtotal ?? null,
      lines: evaluationCart
        .filter(
          (line): line is CartLine & { productGid: string } =>
            line.productGid !== null,
        )
        .map((line) => ({
          productGid: line.productGid,
          variantGid: line.variantGid,
          quantity: line.quantity,
        })),
    },
    customer: { loggedIn: options.customerLoggedIn ?? null },
    timeZone: shopRow?.ianaTimezone ?? null,
    now,
  };

  const scheduled = timed.filter((rule) => {
    if (rule.conditionGroups.length === 0) return true;
    try {
      const tree = conditionTree(rule.conditionGroups);
      validateConditionTree(tree);
      return conditionsMatch(tree, conditionContext);
    } catch (error) {
      logger.warn("Skipping storefront rule with an invalid condition tree", {
        shopId,
        ruleId: rule.id,
        error: toErrorMessage(error),
      });
      return false;
    }
  });

  const autoRules = scheduled.filter((rule) =>
    rule.sources.some((source) => source !== "MANUAL"),
  );
  const maxLookback = autoRules.reduce(
    (hours, rule) => Math.max(hours, rule.autoLookbackHours),
    0,
  );
  const activity =
    maxLookback > 0 ? await loadRecentActivity(shopId, maxLookback) : [];

  const cartVariants = new Set(
    evaluationCart
      .filter((line) => line.quantity > 0 && line.variantGid)
      .map((line) => line.variantGid as string),
  );

  const autoByRule = new Map<
    string,
    ReturnType<typeof candidatesForRule>
  >();
  for (const rule of autoRules) {
    autoByRule.set(rule.id, candidatesForRule(activity, rule, options.cartToken ?? null));
  }

  const engineRules: EngineRule[] = scheduled.map((rule) => {
    const manualOffers: EngineOffer[] = rule.offers.map((offer) => ({
      id: offer.id,
      productGid: offer.productGid,
      variantGid: offer.variantGid,
      defaultQuantity: offer.defaultQuantity,
      minQuantity: offer.minQuantity,
      maxQuantity: offer.maxQuantity,
      position: offer.position,
      active: offer.active,
    }));

    const candidates = autoByRule.get(rule.id);
    const merged: EngineOffer[] = [];
    const seen = new Set<string>();
    let autoCount = 0;
    const autoCap = rule.autoMaxOffers ?? maxOffers;

    const addOffer = (offer: EngineOffer) => {
      if (seen.has(offer.variantGid)) return false;
      seen.add(offer.variantGid);
      merged.push({ ...offer, position: merged.length });
      return true;
    };

    const addCandidates = (list: AutoCandidate[]) => {
      for (const candidate of list) {
        if (autoCount >= autoCap) break;
        if (cartVariants.has(candidate.variantGid)) continue;
        const id = syntheticOfferId(
          rule.id,
          candidate.productGid,
          candidate.variantGid,
        );
        if (!id) continue;
        const added = addOffer({
          id,
          productGid: candidate.productGid,
          variantGid: candidate.variantGid,
          ...AUTO_DEFAULT_QUANTITY,
          position: 0,
          active: true,
        });
        if (added) autoCount += 1;
      }
    };

    for (const source of rule.sources) {
      if (source === "MANUAL") {
        manualOffers.forEach(addOffer);
      } else if (!candidates) {
        continue;
      } else if (source === "RECENTLY_REMOVED") {
        addCandidates(candidates.recentlyRemoved);
      } else {
        addCandidates(candidates.repeated);
      }
    }

    return {
      id: rule.id,
      name: rule.name,
      status: rule.status,
      priority: rule.priority,
      matchMode: rule.matchMode,
      heading: rule.heading,
      maxOffers: rule.maxOffers,
      showOnProductPage: rule.showOnProductPage,
      showOnCartPage: rule.showOnCartPage,
      manualAudience:
        rule.sources.includes("MANUAL") && rule.triggers.length === 0,
      triggers: rule.triggers.map((trigger) => ({
        productGid: trigger.productGid,
        variantGid: trigger.variantGid,
      })),
      offers: merged,
    };
  });

  const productGids = [
    ...new Set(engineRules.flatMap((rule) => rule.offers.map((offer) => offer.productGid))),
  ];

  const snapshots =
    productGids.length === 0
      ? []
      : await db.productSnapshot.findMany({
          where: { shopId, productGid: { in: productGids } },
          include: { variants: { orderBy: { position: "asc" } } },
        });

  const products: EngineProduct[] = snapshots.map((snapshot) => ({
    productGid: snapshot.productGid,
    title: snapshot.title,
    handle: snapshot.handle,
    imageUrl: snapshot.imageUrl,
    status: snapshot.status,
    availableForSale: snapshot.availableForSale,
    currencyCode: snapshot.currencyCode,
    variants: snapshot.variants.map((variant) => ({
      variantGid: variant.variantGid,
      title: variant.title,
      // Decimal(12,2): render money with a stable scale, never recomputed.
      price: variant.price.toFixed(2),
      compareAtPrice:
        variant.compareAtPrice === null ? null : variant.compareAtPrice.toFixed(2),
      availableForSale: variant.availableForSale,
    })),
  }));

  const result = recommendOffers({
    rules: engineRules,
    products,
    cart: evaluationCart,
    surface: options.surface,
    limit: options.limit ?? maxOffers,
    defaultHeading,
    hasCartItems,
  });

  return { enabled: true, ...result };
}
