import type { Experience, Prisma, Shop } from "@prisma/client";
import db from "../db.server";
import {
  conditionsMatch,
  type ConditionContext,
} from "../utils/condition-evaluator";
import {
  validateConditionTree,
  type ConditionGroupNode,
} from "../utils/condition-schema";
import { logger, toErrorMessage } from "../utils/logger.server";
import { getExperienceSupport } from "./placements.server";
import { getSettings } from "./settings.server";

/**
 * Checkout offer evaluation shared by both checkout experiences.
 *
 * The extension supplies relevance hints (cart or purchase lines, subtotal,
 * country, signed-in state); everything that decides what may be sold — rules,
 * copy, prices and availability — is loaded here from the shop's own rows.
 * Product identity, price and availability always come from ProductSnapshot.
 */

export type CheckoutLine = {
  productGid: string;
  variantGid: string | null;
  quantity: number;
};

export type CheckoutContext = {
  /** Lines used for trigger matching and already-in-cart exclusion. */
  lines: CheckoutLine[];
  /** Cart subtotal in shop currency; pre-purchase only. */
  subtotal?: number | null;
  /** From the verified token/customer claim, never from the request body. */
  customerLoggedIn?: boolean | null;
  shippingCountry?: string | null;
  marketCountry?: string | null;
  /** Completed order total and line count; post-purchase only. */
  orderTotal?: number | null;
  orderLineCount?: number | null;
  now?: Date;
};

export type CheckoutOffer = {
  /** RecommendedProduct id, the analytics offer id. */
  id: string;
  productGid: string;
  variantGid: string;
  productTitle: string;
  variantTitle: string;
  imageUrl: string | null;
  price: string;
  compareAtPrice: string | null;
  currencyCode: string | null;
  quantity: number;
  headline: string;
  body: string | null;
  ctaLabel: string;
};

export type CheckoutOfferResult = {
  /** Delivery is switched on for this shop and experience. */
  enabled: boolean;
  heading: string | null;
  offers: CheckoutOffer[];
};

/** Shopify allows at most three accepted offers on a post-purchase page. */
export const MAX_POST_PURCHASE_OFFERS = 3;

const DEFAULT_CTA: Record<Experience, string> = {
  PRE_PURCHASE: "Add to cart",
  POST_PURCHASE: "Add to order",
};

type GroupRow = Prisma.OfferConditionGroupGetPayload<{
  include: { conditions: true };
}>;

const groupInclude = {
  conditions: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.OfferConditionGroupInclude;

const offerInclude = {
  where: { active: true },
  orderBy: [{ position: "asc" }, { id: "asc" }],
} satisfies Prisma.RecommendedProductFindManyArgs;

function cleanCopy(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Root groups are the rows without a parent; children are attached by parent
 * id. Rows arrive ordered by position, so relative order is preserved.
 */
function conditionTree(groups: GroupRow[]): ConditionGroupNode[] {
  const byParent = new Map<string | null, GroupRow[]>();

  for (const group of groups) {
    const siblings = byParent.get(group.parentGroupId);
    if (siblings) siblings.push(group);
    else byParent.set(group.parentGroupId, [group]);
  }

  const build = (group: GroupRow): ConditionGroupNode => ({
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

function triggerMatchesLine(
  trigger: { productGid: string; variantGid: string },
  line: CheckoutLine,
): boolean {
  if (line.productGid !== trigger.productGid) return false;
  if (!trigger.variantGid) return true;
  return line.variantGid === trigger.variantGid;
}

function triggersMatch(
  rule: {
    triggers: Array<{ productGid: string; variantGid: string }>;
    matchMode: "ANY" | "ALL";
  },
  lines: CheckoutLine[],
): boolean {
  // A rule without trigger products is the unconditional "any cart" audience:
  // checkout always contains at least one line, so it matches immediately.
  if (rule.triggers.length === 0) return lines.length > 0;
  if (rule.matchMode === "ALL") {
    return rule.triggers.every((trigger) =>
      lines.some((line) => triggerMatchesLine(trigger, line)),
    );
  }
  return rule.triggers.some((trigger) =>
    lines.some((line) => triggerMatchesLine(trigger, line)),
  );
}

function conditionContext(
  experience: Experience,
  context: CheckoutContext,
  timeZone: string | null,
): ConditionContext {
  return {
    cart:
      experience === "PRE_PURCHASE"
        ? { subtotal: context.subtotal ?? null, lines: context.lines }
        : null,
    order:
      experience === "POST_PURCHASE"
        ? {
            total: context.orderTotal ?? null,
            lineCount: context.orderLineCount ?? context.lines.length,
          }
        : null,
    customer: { loggedIn: context.customerLoggedIn ?? null },
    shippingCountry: context.shippingCountry ?? null,
    marketCountry: context.marketCountry ?? null,
    timeZone,
    now: context.now,
  };
}

type SnapshotView = {
  title: string;
  imageUrl: string | null;
  status: string;
  availableForSale: boolean;
  currencyCode: string | null;
  variants: Map<
    string,
    {
      title: string;
      price: string;
      compareAtPrice: string | null;
      availableForSale: boolean;
    }
  >;
};

async function loadOfferSnapshots(
  shopId: string,
  productGids: string[],
): Promise<Map<string, SnapshotView>> {
  if (productGids.length === 0) return new Map();

  const snapshots = await db.productSnapshot.findMany({
    where: { shopId, productGid: { in: productGids } },
    include: { variants: true },
  });

  return new Map(
    snapshots.map((snapshot) => [
      snapshot.productGid,
      {
        title: snapshot.title,
        imageUrl: snapshot.imageUrl,
        status: snapshot.status,
        availableForSale: snapshot.availableForSale,
        currencyCode: snapshot.currencyCode,
        variants: new Map(
          snapshot.variants.map((variant) => [
            variant.variantGid,
            {
              title: variant.title,
              price: variant.price.toString(),
              compareAtPrice: variant.compareAtPrice?.toString() ?? null,
              availableForSale: variant.availableForSale,
            },
          ]),
        ),
      },
    ]),
  );
}

function requestedQuantity(
  offer: { defaultQuantity: number; minQuantity: number; maxQuantity: number },
): number {
  const min = Math.max(1, offer.minQuantity);
  const max = Math.max(min, offer.maxQuantity);
  return Math.min(Math.max(offer.defaultQuantity, min), max);
}

/**
 * Returns the offers a buyer may see in the given checkout experience.
 *
 * Order is deterministic: rules by priority then id, offers by position then
 * id. The first qualifying rule/offer for a product or variant wins, so the
 * same inputs always produce the same payload.
 */
export async function getCheckoutOffers(
  shop: Pick<Shop, "id" | "isPlus" | "ianaTimezone">,
  experience: Experience,
  context: CheckoutContext,
): Promise<CheckoutOfferResult> {
  const [settings, support] = await Promise.all([
    getSettings(shop.id),
    Promise.resolve(getExperienceSupport(shop)[experience]),
  ]);

  if (!support.available || !support.implemented || !settings.enabled) {
    return { enabled: false, heading: null, offers: [] };
  }

  const now = context.now ?? new Date();
  const limit =
    experience === "POST_PURCHASE"
      ? Math.min(settings.maxOffers, MAX_POST_PURCHASE_OFFERS)
      : settings.maxOffers;

  const rules = await db.recommendationRule.findMany({
    where: {
      shopId: shop.id,
      status: "ACTIVE",
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
    },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
    include: {
      triggers: true,
      offers: offerInclude,
      experiences: {
        where: { experience, enabled: true },
        select: { enabled: true, headline: true, body: true, ctaLabel: true },
      },
      conditionGroups: { include: groupInclude },
    },
  });

  const contextForConditions = conditionContext(
    experience,
    context,
    shop.ianaTimezone,
  );

  type EligibleRule = (typeof rules)[number] & {
    experienceCopy: (typeof rules)[number]["experiences"][number];
  };
  const eligible: EligibleRule[] = [];

  // Kept so an empty result can be explained instead of silently skipped.
  const skippedRules = {
    experienceDisabled: 0,
    triggerMiss: 0,
    conditionMiss: 0,
    invalidTree: 0,
  };

  for (const rule of rules) {
    const experienceCopy = rule.experiences[0];
    if (!experienceCopy?.enabled) {
      skippedRules.experienceDisabled += 1;
      continue;
    }
    if (!triggersMatch(rule, context.lines)) {
      skippedRules.triggerMiss += 1;
      continue;
    }

    let tree: ConditionGroupNode[];
    try {
      tree = conditionTree(rule.conditionGroups);
      validateConditionTree(tree);
    } catch (error) {
      // A stored tree that no longer validates must not decide a sale.
      skippedRules.invalidTree += 1;
      logger.warn("Skipping rule with an invalid condition tree", {
        shopId: shop.id,
        ruleId: rule.id,
        error: toErrorMessage(error),
      });
      continue;
    }

    if (!conditionsMatch(tree, contextForConditions)) {
      skippedRules.conditionMiss += 1;
      continue;
    }
    eligible.push({ ...rule, experienceCopy });
  }

  const diagnostics = () => ({
    shopId: shop.id,
    experience,
    lines: context.lines.length,
    activeRules: rules.length,
    eligibleRules: eligible.length,
    skippedRules,
  });

  if (eligible.length === 0) {
    logger.info("Checkout offers: no rule matched this checkout", diagnostics());
    return { enabled: true, heading: null, offers: [] };
  }

  const productGids = [
    ...new Set(eligible.flatMap((rule) => rule.offers.map((offer) => offer.productGid))),
  ];
  const snapshots = await loadOfferSnapshots(shop.id, productGids);

  const linesProducts = new Set(context.lines.map((line) => line.productGid));
  const linesVariants = new Set(
    context.lines
      .map((line) => line.variantGid)
      .filter((value): value is string => Boolean(value)),
  );
  const claimedProducts = new Set<string>();
  const claimedVariants = new Set<string>();

  const offers: CheckoutOffer[] = [];
  let heading: string | null = null;

  const rejectedOffers = {
    snapshotMissing: 0,
    productUnavailable: 0,
    variantUnavailable: 0,
    alreadyInPurchase: 0,
    duplicateClaim: 0,
    ruleCapReached: 0,
  };

  for (const rule of eligible) {
    if (offers.length >= limit) break;

    const ruleCap = Math.min(rule.maxOffers ?? limit, limit);
    let ruleOfferCount = 0;

    for (const offer of rule.offers) {
      if (offers.length >= limit) break;
      if (!offer.active) continue;

      const snapshot = snapshots.get(offer.productGid);
      const variant = snapshot?.variants.get(offer.variantGid);

      if (!snapshot || snapshot.status !== "ACTIVE") {
        rejectedOffers.snapshotMissing += 1;
        continue;
      }
      if (!snapshot.availableForSale) {
        rejectedOffers.productUnavailable += 1;
        continue;
      }
      if (!variant?.availableForSale) {
        rejectedOffers.variantUnavailable += 1;
        continue;
      }
      if (linesProducts.has(offer.productGid)) {
        rejectedOffers.alreadyInPurchase += 1;
        continue;
      }
      if (linesVariants.has(offer.variantGid)) {
        rejectedOffers.alreadyInPurchase += 1;
        continue;
      }
      if (claimedProducts.has(offer.productGid)) {
        rejectedOffers.duplicateClaim += 1;
        continue;
      }
      if (claimedVariants.has(offer.variantGid)) {
        rejectedOffers.duplicateClaim += 1;
        continue;
      }
      if (ruleOfferCount >= ruleCap) {
        rejectedOffers.ruleCapReached += 1;
        break;
      }

      offers.push({
        id: offer.id,
        productGid: offer.productGid,
        variantGid: offer.variantGid,
        productTitle: snapshot.title,
        variantTitle: variant.title,
        imageUrl: snapshot.imageUrl,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        currencyCode: snapshot.currencyCode,
        quantity: requestedQuantity(offer),
        headline:
          cleanCopy(rule.experienceCopy.headline) ??
          cleanCopy(rule.heading) ??
          snapshot.title,
        body:
          cleanCopy(rule.experienceCopy.body) ?? cleanCopy(rule.description),
        ctaLabel:
          cleanCopy(rule.experienceCopy.ctaLabel) ?? DEFAULT_CTA[experience],
      });

      claimedProducts.add(offer.productGid);
      claimedVariants.add(offer.variantGid);
      ruleOfferCount += 1;

      if (!heading) {
        heading =
          cleanCopy(rule.heading) ??
          cleanCopy(settings.defaultHeading) ??
          "You may also like";
      }
    }
  }

  if (offers.length === 0) {
    logger.info("Checkout offers: rules matched but no offer was sellable", {
      ...diagnostics(),
      rejectedOffers,
    });
  }

  return { enabled: true, heading: offers.length > 0 ? heading : null, offers };
}
