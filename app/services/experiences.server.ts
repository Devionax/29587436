import type { Experience, OfferExperience, Prisma } from "@prisma/client";
import db from "../db.server";
import { InvalidInputError, TenantResourceNotFoundError } from "../utils/errors";

/**
 * Per-experience offer configuration.
 *
 * `shopId` is stored on every row for tenant scoping, but the two foreign keys
 * (shop and rule) cannot prove that the row's shop matches the rule's shop.
 * Every operation here verifies rule ownership before writing, and scopes reads
 * and deletes by both ids.
 */

export type OfferExperienceInput = {
  experience: Experience;
  enabled?: boolean;
  headline?: string | null;
  body?: string | null;
  ctaLabel?: string | null;
};

export type NormalizedOfferExperience = {
  experience: Experience;
  enabled: boolean;
  headline: string | null;
  body: string | null;
  ctaLabel: string | null;
};

const EXPERIENCES: readonly Experience[] = ["PRE_PURCHASE", "POST_PURCHASE"];

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function normalizeOfferExperiences(
  entries: OfferExperienceInput[],
): NormalizedOfferExperience[] {
  const seen = new Set<Experience>();

  return entries.map((entry) => {
    if (!EXPERIENCES.includes(entry.experience)) {
      throw new InvalidInputError("Unknown offer experience");
    }
    if (seen.has(entry.experience)) {
      throw new InvalidInputError(
        "Each experience can appear only once in an offer",
      );
    }
    seen.add(entry.experience);

    return {
      experience: entry.experience,
      enabled: entry.enabled ?? true,
      headline: cleanText(entry.headline),
      body: cleanText(entry.body),
      ctaLabel: cleanText(entry.ctaLabel),
    };
  });
}

function normalizeOne(entry: OfferExperienceInput): NormalizedOfferExperience {
  const normalized = normalizeOfferExperiences([entry])[0];
  if (!normalized) {
    throw new InvalidInputError("An offer experience is required");
  }
  return normalized;
}

/** True when the supplied set would actually show the offer in checkout. */
export function experiencesIncludePrePurchase(
  experiences: Array<Pick<NormalizedOfferExperience, "experience" | "enabled">>,
): boolean {
  return experiences.some(
    (entry) => entry.experience === "PRE_PURCHASE" && entry.enabled,
  );
}

/**
 * Legacy `showOnCheckout` and the explicit experience set must agree when a
 * caller supplies both. Disagreement is a caller bug, not something to resolve
 * silently: either choice would hide the mistake.
 */
export function assertLegacyExperienceConsistency(
  experiences: NormalizedOfferExperience[],
  showOnCheckout: boolean | undefined,
): void {
  if (showOnCheckout === undefined) return;
  if (experiencesIncludePrePurchase(experiences) !== showOnCheckout) {
    throw new InvalidInputError(
      "showOnCheckout must match whether the PRE_PURCHASE experience is enabled",
    );
  }
}

async function assertRuleOwned(
  client: Prisma.TransactionClient | typeof db,
  shopId: string,
  ruleId: string,
): Promise<void> {
  const rule = await client.recommendationRule.findFirst({
    where: { id: ruleId, shopId },
    select: { id: true },
  });
  if (!rule) {
    throw new TenantResourceNotFoundError("Offer", ruleId);
  }
}

export async function listOfferExperiences(
  shopId: string,
  ruleId: string,
): Promise<OfferExperience[]> {
  await assertRuleOwned(db, shopId, ruleId);
  return db.offerExperience.findMany({
    where: { shopId, ruleId },
    orderBy: { experience: "asc" },
  });
}

export async function upsertOfferExperience(
  shopId: string,
  ruleId: string,
  input: OfferExperienceInput,
): Promise<OfferExperience> {
  const normalized = normalizeOne(input);

  return db.$transaction(async (tx) => {
    await assertRuleOwned(tx, shopId, ruleId);
    return tx.offerExperience.upsert({
      where: {
        ruleId_experience: {
          ruleId,
          experience: normalized.experience,
        },
      },
      create: {
        shopId,
        ruleId,
        experience: normalized.experience,
        enabled: normalized.enabled,
        headline: normalized.headline,
        body: normalized.body,
        ctaLabel: normalized.ctaLabel,
      },
      update: {
        enabled: normalized.enabled,
        headline: normalized.headline,
        body: normalized.body,
        ctaLabel: normalized.ctaLabel,
      },
    });
  });
}

export async function deleteOfferExperience(
  shopId: string,
  ruleId: string,
  experience: Experience,
): Promise<void> {
  const result = await db.offerExperience.deleteMany({
    where: { shopId, ruleId, experience },
  });
  if (result.count === 0) {
    throw new TenantResourceNotFoundError(
      "Offer experience",
      `${ruleId}:${experience}`,
    );
  }
}

/**
 * Applies an explicit, complete experience set. Listed experiences are written
 * in full; rows not listed are disabled, never deleted, so copy is preserved if
 * the experience is re-enabled later.
 */
export async function syncOfferExperiences(
  tx: Prisma.TransactionClient,
  shopId: string,
  ruleId: string,
  desired: NormalizedOfferExperience[],
): Promise<void> {
  for (const entry of desired) {
    await tx.offerExperience.upsert({
      where: {
        ruleId_experience: { ruleId, experience: entry.experience },
      },
      create: {
        shopId,
        ruleId,
        experience: entry.experience,
        enabled: entry.enabled,
        headline: entry.headline,
        body: entry.body,
        ctaLabel: entry.ctaLabel,
      },
      update: {
        enabled: entry.enabled,
        headline: entry.headline,
        body: entry.body,
        ctaLabel: entry.ctaLabel,
      },
    });
  }

  await tx.offerExperience.updateMany({
    where: {
      shopId,
      ruleId,
      experience: { notIn: desired.map((entry) => entry.experience) },
    },
    data: { enabled: false },
  });
}

/**
 * Mirrors the legacy checkout flag onto PRE_PURCHASE without touching the
 * post-purchase row or any copy, and without deleting a row when the flag is
 * turned off.
 */
export async function reconcileLegacyPrePurchase(
  tx: Prisma.TransactionClient,
  shopId: string,
  ruleId: string,
  showOnCheckout: boolean,
): Promise<void> {
  if (showOnCheckout) {
    await tx.offerExperience.upsert({
      where: {
        ruleId_experience: { ruleId, experience: "PRE_PURCHASE" },
      },
      create: {
        shopId,
        ruleId,
        experience: "PRE_PURCHASE",
        enabled: true,
      },
      update: { enabled: true },
    });
    return;
  }

  await tx.offerExperience.updateMany({
    where: { shopId, ruleId, experience: "PRE_PURCHASE" },
    data: { enabled: false },
  });
}
