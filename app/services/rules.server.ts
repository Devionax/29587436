import type {
  ConditionField,
  ConditionJoinOp,
  ConditionOperator,
  MatchMode,
  OfferSource,
  Prisma,
  RuleStatus,
} from "@prisma/client";
import db from "../db.server";
import { InvalidInputError, TenantResourceNotFoundError } from "../utils/errors";
import {
  assertActiveRuleCapacity,
  assertOfferCapacity,
  assertRuleCapacity,
} from "./entitlement.server";
import {
  assertLegacyExperienceConsistency,
  experiencesIncludePrePurchase,
  normalizeOfferExperiences,
  reconcileLegacyPrePurchase,
  syncOfferExperiences,
} from "./experiences.server";
import type {
  NormalizedOfferExperience,
  OfferExperienceInput,
} from "./experiences.server";

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

/**
 * Already-normalized condition group. Values are validated by the caller
 * (`rule-form.server.ts` or the condition service) before they reach here.
 */
export type ConditionGroupWrite = {
  joinOp: ConditionJoinOp;
  conditions: Array<{
    field: ConditionField;
    operator: ConditionOperator;
    valueJson: unknown;
  }>;
  children?: ConditionGroupWrite[];
};

export type RuleWriteInput = {
  name: string;
  description?: string | null;
  status?: RuleStatus;
  priority?: number;
  matchMode?: MatchMode;
  heading?: string | null;
  maxOffers?: number | null;
  /** Priority order matters; the engine concatenates sources in this order. */
  sources?: OfferSource[];
  showOnCheckout?: boolean;
  autoLookbackHours?: number;
  autoMaxOffers?: number | null;
  autoMinRepeats?: number;
  prioritizeRepeats?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  triggers: TriggerInput[];
  offers: OfferInput[];
  /**
   * Complete desired condition tree. Omitted means "leave conditions alone" on
   * update; an array replaces the tree and `[]` clears it.
   */
  conditions?: ConditionGroupWrite[] | null;
  /**
   * Complete desired experience set. Omitted means "leave experiences alone" on
   * update; an explicit list replaces the set (unlisted experiences are
   * disabled, never deleted).
   */
  experiences?: OfferExperienceInput[];
};

export const ruleDetailInclude = {
  triggers: { orderBy: { createdAt: "asc" } },
  offers: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.RecommendationRuleInclude;

export type RuleDetail = Prisma.RecommendationRuleGetPayload<{
  include: typeof ruleDetailInclude;
}>;

/** Copies only writable columns. Never spread request input into Prisma. */
function ruleFields(
  input: RuleWriteInput,
  showOnCheckout: boolean | undefined = input.showOnCheckout,
) {
  return {
    name: input.name,
    description: input.description ?? null,
    status: input.status,
    priority: input.priority,
    matchMode: input.matchMode,
    heading: input.heading ?? null,
    maxOffers: input.maxOffers ?? null,
    // Storefront placements are retired for this release; every write clears
    // them so no rule can opt into a surface the app no longer delivers.
    showOnProductPage: false,
    showOnCartPage: false,
    sources: input.sources,
    showOnCheckout,
    autoLookbackHours: input.autoLookbackHours,
    autoMaxOffers: input.autoMaxOffers,
    autoMinRepeats: input.autoMinRepeats,
    prioritizeRepeats: input.prioritizeRepeats,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  };
}

function resolvedExperiences(
  input: RuleWriteInput,
): NormalizedOfferExperience[] | undefined {
  if (input.experiences === undefined) return undefined;
  const experiences = normalizeOfferExperiences(input.experiences);
  assertLegacyExperienceConsistency(experiences, input.showOnCheckout);
  return experiences;
}

function legacyShowOnCheckout(
  input: RuleWriteInput,
  experiences: NormalizedOfferExperience[] | undefined,
): boolean | undefined {
  if (experiences !== undefined) return experiencesIncludePrePurchase(experiences);
  return input.showOnCheckout;
}

function assertUniqueItems(input: RuleWriteInput): void {
  if (input.sources) {
    if (input.sources.length === 0) {
      throw new InvalidInputError("An offer needs at least one recommendation source");
    }
    if (new Set(input.sources).size !== input.sources.length) {
      throw new InvalidInputError("Recommendation sources must be unique");
    }
  }

  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
    throw new InvalidInputError("The end date must be after the start date");
  }

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
  const offerProducts = new Set<string>();
  for (const offer of input.offers) {
    if (offerKeys.has(offer.variantGid)) {
      throw new InvalidInputError(
        `Duplicate offer variant ${offer.variantGid} in one offer`,
      );
    }
    if (offerProducts.has(offer.productGid)) {
      throw new InvalidInputError(
        "Each product can appear only once in an offer; remove the duplicate product",
      );
    }
    offerKeys.add(offer.variantGid);
    offerProducts.add(offer.productGid);
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

/**
 * Writes a condition tree for the rule. Groups are created parents-first so a
 * child can reference its parent id; conditions are inserted flat per group.
 */
async function createConditionNodes(
  tx: Prisma.TransactionClient,
  shopId: string,
  ruleId: string,
  groups: ConditionGroupWrite[],
  parentGroupId: string | null,
): Promise<void> {
  for (const [index, group] of groups.entries()) {
    const created = await tx.offerConditionGroup.create({
      data: {
        shopId,
        ruleId,
        parentGroupId,
        joinOp: group.joinOp,
        position: index,
      },
      select: { id: true },
    });

    if (group.conditions.length > 0) {
      await tx.offerCondition.createMany({
        data: group.conditions.map((condition, position) => ({
          shopId,
          groupId: created.id,
          field: condition.field,
          operator: condition.operator,
          valueJson: condition.valueJson as Prisma.InputJsonValue,
          position,
        })),
      });
    }

    if (group.children && group.children.length > 0) {
      await createConditionNodes(tx, shopId, ruleId, group.children, created.id);
    }
  }
}

type StoredConditionGroup = Prisma.OfferConditionGroupGetPayload<{
  include: { conditions: true };
}>;

/** Rebuilds the nested write shape from stored rows for duplication. */
function conditionWrites(groups: StoredConditionGroup[]): ConditionGroupWrite[] {
  const byParent = new Map<string | null, StoredConditionGroup[]>();
  for (const group of groups) {
    const siblings = byParent.get(group.parentGroupId);
    if (siblings) siblings.push(group);
    else byParent.set(group.parentGroupId, [group]);
  }

  const build = (group: StoredConditionGroup): ConditionGroupWrite => ({
    joinOp: group.joinOp,
    conditions: group.conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      valueJson: condition.valueJson,
    })),
    children: (byParent.get(group.id) ?? []).map(build),
  });

  return (byParent.get(null) ?? []).map(build);
}

export async function listRules(shopId: string) {
  return db.recommendationRule.findMany({
    where: { shopId },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    include: {
      _count: { select: { triggers: true, offers: true } },
      experiences: {
        where: { enabled: true },
        select: { experience: true },
        orderBy: { experience: "asc" },
      },
    },
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
  if (input.status === "ACTIVE") {
    await assertActiveRuleCapacity(shopId);
  }

  const explicitExperiences = resolvedExperiences(input);
  const experiences =
    explicitExperiences ??
    (input.showOnCheckout === true
      ? [
          {
            experience: "PRE_PURCHASE" as const,
            enabled: true,
            headline: null,
            body: null,
            ctaLabel: null,
          },
        ]
      : undefined);
  const showOnCheckout = legacyShowOnCheckout(input, experiences);

  const data: Prisma.RecommendationRuleCreateInput = {
    shop: { connect: { id: shopId } },
    ...ruleFields(input, showOnCheckout),
    triggers: { create: triggerRows(shopId, input.triggers) },
    offers: { create: offerRows(shopId, input.offers) },
    ...(experiences && experiences.length > 0
      ? {
          experiences: {
            create: experiences.map((entry) => ({ shopId, ...entry })),
          },
        }
      : {}),
  };

  const conditionGroups =
    input.conditions && input.conditions.length > 0 ? input.conditions : null;

  if (!conditionGroups) {
    return db.recommendationRule.create({
      data,
      include: ruleDetailInclude,
    });
  }

  return db.$transaction(async (tx) => {
    const rule = await tx.recommendationRule.create({
      data,
      include: ruleDetailInclude,
    });
    await createConditionNodes(tx, shopId, rule.id, conditionGroups, null);
    return rule;
  });
}

export async function updateRule(
  shopId: string,
  ruleId: string,
  input: RuleWriteInput,
): Promise<RuleDetail> {
  assertUniqueItems(input);
  await assertOfferCapacity(shopId, input.offers.length);
  if (input.status === "ACTIVE") {
    await assertActiveRuleCapacity(shopId, ruleId);
  }

  const experiences = resolvedExperiences(input);
  const showOnCheckout = legacyShowOnCheckout(input, experiences);

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

    const updated = await tx.recommendationRule.update({
      where: { id: owned.id },
      data: {
        ...ruleFields(input, showOnCheckout),
        triggers: { create: triggerRows(shopId, input.triggers) },
        offers: { create: offerRows(shopId, input.offers) },
      },
      include: ruleDetailInclude,
    });

    if (input.conditions !== undefined) {
      // Removing groups cascades to their conditions; this only ever touches
      // the submitted rule inside the current shop.
      await tx.offerConditionGroup.deleteMany({ where: { ruleId, shopId } });
      if (input.conditions && input.conditions.length > 0) {
        await createConditionNodes(tx, shopId, ruleId, input.conditions, null);
      }
    }

    if (experiences !== undefined) {
      await syncOfferExperiences(tx, shopId, ruleId, experiences);
    } else if (input.showOnCheckout !== undefined) {
      await reconcileLegacyPrePurchase(
        tx,
        shopId,
        ruleId,
        input.showOnCheckout,
      );
    }

    return updated;
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

  const sourceExperiences = await db.offerExperience.findMany({
    where: { shopId, ruleId },
    orderBy: { experience: "asc" },
  });
  const experiences: OfferExperienceInput[] = sourceExperiences.map((entry) => ({
    experience: entry.experience,
    enabled: entry.enabled,
    headline: entry.headline,
    body: entry.body,
    ctaLabel: entry.ctaLabel,
  }));

  const sourceConditions = await db.offerConditionGroup.findMany({
    where: { shopId, ruleId },
    include: {
      conditions: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
    },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });

  return createRule(shopId, {
    name: `${source.name} (copy)`,
    description: source.description,
    status: "DRAFT",
    priority: source.priority,
    matchMode: source.matchMode,
    heading: source.heading,
    maxOffers: source.maxOffers,
    sources: source.sources,
    // The copied rows are authoritative; the legacy flag is derived from them.
    experiences,
    conditions: conditionWrites(sourceConditions),
    autoLookbackHours: source.autoLookbackHours,
    autoMaxOffers: source.autoMaxOffers,
    autoMinRepeats: source.autoMinRepeats,
    prioritizeRepeats: source.prioritizeRepeats,
    startsAt: source.startsAt,
    endsAt: source.endsAt,
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
