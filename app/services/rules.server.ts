import type { MatchMode, Prisma, RuleStatus } from "@prisma/client";
import db from "../db.server";
import { InvalidInputError, TenantResourceNotFoundError } from "../utils/errors";
import {
  assertActiveRuleCapacity,
  assertOfferCapacity,
  assertRuleCapacity,
} from "./entitlement.server";

/**
 * Tenant-scoped data access for recommendation rules.
 *
 * Every function takes an authenticated shopId as its first argument and
 * scopes every query by it. Callers must resolve shopId from a verified
 * Shopify session, never from request input.
 */

export type TriggerInput = {
  productGid: string;
  /** Empty or omitted means "any variant of this product". */
  variantGid?: string | null;
};

export type OfferInput = {
  productGid: string;
  variantGid: string;
  defaultQuantity?: number;
  minQuantity?: number;
  maxQuantity?: number;
  position?: number;
  active?: boolean;
};

export type RuleWriteInput = {
  name: string;
  description?: string | null;
  status?: RuleStatus;
  priority?: number;
  matchMode?: MatchMode;
  heading?: string | null;
  maxOffers?: number | null;
  showOnProductPage?: boolean;
  showOnCartPage?: boolean;
  triggers: TriggerInput[];
  offers: OfferInput[];
};

export const ruleDetailInclude = {
  triggers: { orderBy: { createdAt: "asc" } },
  offers: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.RecommendationRuleInclude;

export type RuleDetail = Prisma.RecommendationRuleGetPayload<{
  include: typeof ruleDetailInclude;
}>;

/** Copies only writable columns. Never spread request input into Prisma. */
function ruleFields(input: RuleWriteInput) {
  return {
    name: input.name,
    description: input.description ?? null,
    status: input.status,
    priority: input.priority,
    matchMode: input.matchMode,
    heading: input.heading ?? null,
    maxOffers: input.maxOffers ?? null,
    showOnProductPage: input.showOnProductPage,
    showOnCartPage: input.showOnCartPage,
  };
}

function assertUniqueItems(input: RuleWriteInput): void {
  const triggerKeys = new Set<string>();
  for (const trigger of input.triggers) {
    const key = `${trigger.productGid}|${trigger.variantGid ?? ""}`;
    if (triggerKeys.has(key)) {
      throw new InvalidInputError(
        `Duplicate trigger product ${trigger.productGid} in one rule`,
      );
    }
    triggerKeys.add(key);
  }

  const offerKeys = new Set<string>();
  for (const offer of input.offers) {
    if (offerKeys.has(offer.variantGid)) {
      throw new InvalidInputError(
        `Duplicate offer variant ${offer.variantGid} in one rule`,
      );
    }
    offerKeys.add(offer.variantGid);
  }
}

function triggerRows(shopId: string, triggers: TriggerInput[]) {
  return triggers.map((trigger) => ({
    shopId,
    productGid: trigger.productGid,
    variantGid: trigger.variantGid ?? "",
  }));
}

function offerRows(shopId: string, offers: OfferInput[]) {
  return offers.map((offer, index) => ({
    shopId,
    productGid: offer.productGid,
    variantGid: offer.variantGid,
    defaultQuantity: offer.defaultQuantity ?? 1,
    minQuantity: offer.minQuantity ?? 1,
    maxQuantity: offer.maxQuantity ?? 10,
    position: offer.position ?? index,
    active: offer.active ?? true,
  }));
}

export async function listRules(shopId: string) {
  return db.recommendationRule.findMany({
    where: { shopId },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { triggers: true, offers: true } } },
  });
}

export async function countRules(shopId: string): Promise<number> {
  return db.recommendationRule.count({ where: { shopId } });
}

export async function getRule(
  shopId: string,
  ruleId: string,
): Promise<RuleDetail | null> {
  return db.recommendationRule.findFirst({
    where: { id: ruleId, shopId },
    include: ruleDetailInclude,
  });
}

export async function createRule(
  shopId: string,
  input: RuleWriteInput,
): Promise<RuleDetail> {
  assertUniqueItems(input);
  await assertRuleCapacity(shopId);
  await assertOfferCapacity(shopId, input.offers.length);

  return db.recommendationRule.create({
    data: {
      shopId,
      ...ruleFields(input),
      triggers: { create: triggerRows(shopId, input.triggers) },
      offers: { create: offerRows(shopId, input.offers) },
    },
    include: ruleDetailInclude,
  });
}

export async function updateRule(
  shopId: string,
  ruleId: string,
  input: RuleWriteInput,
): Promise<RuleDetail> {
  assertUniqueItems(input);
  await assertOfferCapacity(shopId, input.offers.length);

  return db.$transaction(async (tx) => {
    const owned = await tx.recommendationRule.findFirst({
      where: { id: ruleId, shopId },
      select: { id: true },
    });
    if (!owned) {
      throw new TenantResourceNotFoundError("Recommendation rule", ruleId);
    }

    // Children are authoritative in the submitted form, so replace them.
    await tx.triggerProduct.deleteMany({ where: { ruleId, shopId } });
    await tx.recommendedProduct.deleteMany({ where: { ruleId, shopId } });

    return tx.recommendationRule.update({
      where: { id: owned.id },
      data: {
        ...ruleFields(input),
        triggers: { create: triggerRows(shopId, input.triggers) },
        offers: { create: offerRows(shopId, input.offers) },
      },
      include: ruleDetailInclude,
    });
  });
}

export async function setRuleStatus(
  shopId: string,
  ruleId: string,
  status: RuleStatus,
): Promise<void> {
  if (status === "ACTIVE") {
    await assertActiveRuleCapacity(shopId, ruleId);
  }

  const result = await db.recommendationRule.updateMany({
    where: { id: ruleId, shopId },
    data: { status },
  });

  if (result.count === 0) {
    throw new TenantResourceNotFoundError("Recommendation rule", ruleId);
  }
}

export async function deleteRule(shopId: string, ruleId: string): Promise<void> {
  const result = await db.recommendationRule.deleteMany({
    where: { id: ruleId, shopId },
  });

  if (result.count === 0) {
    throw new TenantResourceNotFoundError("Recommendation rule", ruleId);
  }
}

export async function duplicateRule(
  shopId: string,
  ruleId: string,
): Promise<RuleDetail> {
  const source = await getRule(shopId, ruleId);
  if (!source) {
    throw new TenantResourceNotFoundError("Recommendation rule", ruleId);
  }

  return createRule(shopId, {
    name: `${source.name} (copy)`,
    description: source.description,
    status: "DRAFT",
    priority: source.priority,
    matchMode: source.matchMode,
    heading: source.heading,
    maxOffers: source.maxOffers,
    showOnProductPage: source.showOnProductPage,
    showOnCartPage: source.showOnCartPage,
    triggers: source.triggers.map((trigger) => ({
      productGid: trigger.productGid,
      variantGid: trigger.variantGid,
    })),
    offers: source.offers.map((offer) => ({
      productGid: offer.productGid,
      variantGid: offer.variantGid,
      defaultQuantity: offer.defaultQuantity,
      minQuantity: offer.minQuantity,
      maxQuantity: offer.maxQuantity,
      position: offer.position,
      active: offer.active,
    })),
  });
}
