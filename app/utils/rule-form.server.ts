import type {
  ConditionField,
  ConditionOperator,
  Experience,
  MatchMode,
  OfferSource,
  RuleStatus,
} from "@prisma/client";
import type {
  ConditionGroupWrite,
  OfferInput,
  RuleWriteInput,
  TriggerInput,
} from "../services/rules.server";
import {
  CONDITION_LIMITS,
  STOREFRONT_CONDITION_FIELDS,
  normalizeCondition,
  validateConditionTree,
} from "./condition-schema";
import { InvalidInputError } from "./errors";
import { isProductGid, isVariantGid } from "./gid";

/**
 * Parses and validates the offer form before anything reaches the service
 * layer. Everything here is untrusted input: browser-supplied shop identity,
 * prices, statuses and experience availability are never read from the form.
 */

export type RuleFormErrors = Record<string, string>;

export type RuleFormResult =
  | { ok: true; input: RuleWriteInput }
  | { ok: false; errors: RuleFormErrors };

const RULE_STATUSES: RuleStatus[] = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"];
const MATCH_MODES: MatchMode[] = ["ANY", "ALL"];
const SOURCES: OfferSource[] = ["MANUAL", "RECENTLY_REMOVED", "REPEATED_ACTIVITY"];
const EXPERIENCES: Experience[] = ["PRE_PURCHASE", "POST_PURCHASE"];

const LIMITS = {
  name: 120,
  description: 1000,
  heading: 120,
  priorityMax: 100_000,
  triggers: 50,
  offers: 20,
  maxOffersMax: 10,
  quantityMax: 100,
  lookbackHoursMax: 2160,
  minRepeatsMax: 20,
  experienceHeadline: 120,
  experienceBody: 400,
  experienceCta: 40,
} as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type RawTrigger = { productGid?: unknown; variantGid?: unknown };
type RawOffer = {
  productGid?: unknown;
  variantGid?: unknown;
  defaultQuantity?: unknown;
  minQuantity?: unknown;
  maxQuantity?: unknown;
};
type RawExperience = {
  experience?: unknown;
  enabled?: unknown;
  headline?: unknown;
  body?: unknown;
  ctaLabel?: unknown;
};
type RawCondition = { field?: unknown; operator?: unknown; value?: unknown };

export type RuleFormOptions = {
  /** Resolved server-side from the shop plan; never from the form. */
  prePurchaseAvailable?: boolean;
  /** Resolved server-side from the post-purchase access flag. */
  postPurchaseAvailable?: boolean;
};

function text(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function cleanText(value: unknown, limit: number): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (trimmed.length > limit) return "invalid";
  return trimmed === "" ? null : trimmed;
}

function integer(value: string, fallback: number): number {
  if (value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function parseJsonArray<T>(raw: string): T[] | null {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

/**
 * Polaris date fields submit YYYY-MM-DD. Start is inclusive at 00:00 UTC and the
 * end date is inclusive through the end of that day.
 */
function parseDateField(value: string, endOfDay: boolean): Date | null | "invalid" {
  if (!value) return null;
  if (!DATE_ONLY.test(value)) return "invalid";
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

export function parseRuleForm(
  form: FormData,
  options: RuleFormOptions = {},
): RuleFormResult {
  const errors: RuleFormErrors = {};

  const name = text(form, "name");
  if (!name) errors.name = "Give the offer a name.";
  else if (name.length > LIMITS.name) errors.name = `Keep the name under ${LIMITS.name} characters.`;

  const description = text(form, "description");
  if (description.length > LIMITS.description) {
    errors.description = `Keep the description under ${LIMITS.description} characters.`;
  }

  const heading = text(form, "heading");
  if (heading.length > LIMITS.heading) {
    errors.heading = `Keep the heading under ${LIMITS.heading} characters.`;
  }

  const status = text(form, "status") || "DRAFT";
  if (!RULE_STATUSES.includes(status as RuleStatus)) {
    errors.status = "Choose a valid status.";
  }

  const matchMode = text(form, "matchMode") || "ANY";
  if (!MATCH_MODES.includes(matchMode as MatchMode)) {
    errors.matchMode = "Choose a valid match mode.";
  }

  const priority = integer(text(form, "priority"), 100);
  if (!Number.isInteger(priority) || priority < 0 || priority > LIMITS.priorityMax) {
    errors.priority = `Priority must be a whole number from 0 to ${LIMITS.priorityMax}.`;
  }

  const maxOffersRaw = text(form, "maxOffers");
  const maxOffers = maxOffersRaw === "" ? null : integer(maxOffersRaw, 0);
  if (
    maxOffers !== null &&
    (!Number.isInteger(maxOffers) || maxOffers < 1 || maxOffers > LIMITS.maxOffersMax)
  ) {
    errors.maxOffers = `Offer limit must be a whole number from 1 to ${LIMITS.maxOffersMax}, or empty.`;
  }

  const rawExperiences = parseJsonArray<RawExperience>(
    String(form.get("experiences") ?? ""),
  );
  const experiences: Array<{
    experience: Experience;
    enabled: boolean;
    headline: string | null;
    body: string | null;
    ctaLabel: string | null;
  }> = [];
  if (rawExperiences === null) {
    errors.experiences = "Experiences could not be read. Reload the page.";
  } else if (rawExperiences.length === 0) {
    errors.experiences = "Choose at least one checkout experience.";
  } else {
    const seen = new Set<Experience>();
    for (const raw of rawExperiences) {
      const experience = raw.experience;
      if (
        typeof experience !== "string" ||
        !EXPERIENCES.includes(experience as Experience)
      ) {
        errors.experiences = "Choose a valid checkout experience.";
        break;
      }
      if (seen.has(experience as Experience)) {
        errors.experiences = "Each checkout experience can appear only once.";
        break;
      }
      seen.add(experience as Experience);

      if (typeof raw.enabled !== "boolean") {
        errors.experiences = "Experience state could not be read. Reload the page.";
        break;
      }

      const headline = cleanText(raw.headline, LIMITS.experienceHeadline);
      const body = cleanText(raw.body, LIMITS.experienceBody);
      const ctaLabel = cleanText(raw.ctaLabel, LIMITS.experienceCta);
      if (headline === "invalid" || body === "invalid" || ctaLabel === "invalid") {
        errors.experiences =
          `Experience copy is too long: headline ${LIMITS.experienceHeadline}, ` +
          `body ${LIMITS.experienceBody}, call to action ${LIMITS.experienceCta} characters.`;
        break;
      }

      experiences.push({
        experience: experience as Experience,
        enabled: raw.enabled,
        headline,
        body,
        ctaLabel,
      });
    }

    const enabled = experiences.filter((entry) => entry.enabled);
    // The post-purchase page is the only placement this release delivers, so an
    // offer needs at least one enabled checkout experience.
    if (!errors.experiences && enabled.length === 0) {
      errors.experiences = "Choose at least one checkout experience.";
    }

    if (
      !errors.experiences &&
      enabled.some((entry) => entry.experience === "PRE_PURCHASE") &&
      !options.prePurchaseAvailable
    ) {
      errors.experiences =
        "Pre-purchase checkout offers require Shopify Plus. Remove it or upgrade the store.";
    }

    // Post-purchase availability is a deployment concern (POST_PURCHASE_ENABLED
    // and Shopify's grant), not a data problem: the merchant may configure it
    // now and it starts delivering once the deployment enables it.
  }

  const rawSources = parseJsonArray<string>(String(form.get("sources") ?? '["MANUAL"]'));
  let sources: OfferSource[] = ["MANUAL"];
  if (rawSources === null) {
    errors.sources = "Recommendation sources could not be read. Reload the page.";
  } else if (rawSources.length === 0) {
    errors.sources = "Choose at least one recommendation source.";
  } else if (
    rawSources.some((source) => !SOURCES.includes(source as OfferSource)) ||
    new Set(rawSources).size !== rawSources.length
  ) {
    errors.sources = "Choose valid, unique recommendation sources.";
  } else {
    sources = rawSources as OfferSource[];
  }

  const autoLookbackHours = integer(text(form, "autoLookbackHours"), 168);
  if (
    !Number.isInteger(autoLookbackHours) ||
    autoLookbackHours < 1 ||
    autoLookbackHours > LIMITS.lookbackHoursMax
  ) {
    errors.autoLookbackHours = `Lookback must be from 1 to ${LIMITS.lookbackHoursMax} hours.`;
  }

  const autoMaxOffersRaw = text(form, "autoMaxOffers");
  const autoMaxOffers = autoMaxOffersRaw === "" ? null : integer(autoMaxOffersRaw, 0);
  if (
    autoMaxOffers !== null &&
    (!Number.isInteger(autoMaxOffers) ||
      autoMaxOffers < 1 ||
      autoMaxOffers > LIMITS.maxOffersMax)
  ) {
    errors.autoMaxOffers = `Automatic offer limit must be 1 to ${LIMITS.maxOffersMax}, or empty.`;
  }

  const autoMinRepeats = integer(text(form, "autoMinRepeats"), 2);
  if (
    !Number.isInteger(autoMinRepeats) ||
    autoMinRepeats < 1 ||
    autoMinRepeats > LIMITS.minRepeatsMax
  ) {
    errors.autoMinRepeats = `Repeats must be a whole number from 1 to ${LIMITS.minRepeatsMax}.`;
  }

  const startsAt = parseDateField(text(form, "startsAt"), false);
  if (startsAt === "invalid") errors.startsAt = "Enter a valid start date.";
  const endsAt = parseDateField(text(form, "endsAt"), true);
  if (endsAt === "invalid") errors.endsAt = "Enter a valid end date.";
  if (
    startsAt !== "invalid" &&
    endsAt !== "invalid" &&
    startsAt &&
    endsAt &&
    endsAt <= startsAt
  ) {
    errors.endsAt = "The end date must be on or after the start date.";
  }

  const rawTriggers = parseJsonArray<RawTrigger>(String(form.get("triggers") ?? ""));
  const triggers: TriggerInput[] = [];
  if (rawTriggers === null) {
    errors.triggers = "Trigger products could not be read. Reload the page.";
  } else if (rawTriggers.length === 0 && !sources.includes("MANUAL")) {
    // A trigger-less rule is a manual ("any cart") audience; without the Manual
    // source the engine would never produce its offers.
    errors.triggers =
      "Add at least one trigger product, or include Manual selection to offer to any cart.";
  } else if (rawTriggers.length > LIMITS.triggers) {
    errors.triggers = `An offer can have at most ${LIMITS.triggers} trigger products.`;
  } else {
    rawTriggers.forEach((raw, index) => {
      const productGid = typeof raw.productGid === "string" ? raw.productGid : "";
      const variantGid = typeof raw.variantGid === "string" ? raw.variantGid : "";

      if (!isProductGid(productGid)) {
        errors.triggers = `Trigger ${index + 1} is not a valid product.`;
        return;
      }
      if (variantGid && !isVariantGid(variantGid)) {
        errors.triggers = `Trigger ${index + 1} has an invalid variant.`;
        return;
      }
      triggers.push({ productGid, variantGid: variantGid || null });
    });
  }

  const rawOffers = parseJsonArray<RawOffer>(String(form.get("offers") ?? "[]"));
  const offers: OfferInput[] = [];
  if (rawOffers === null) {
    errors.offers = "Offers could not be read. Reload the page.";
  } else if (rawOffers.length > LIMITS.offers) {
    errors.offers = `An offer can have at most ${LIMITS.offers} products.`;
  } else {
    rawOffers.forEach((raw, index) => {
      const productGid = typeof raw.productGid === "string" ? raw.productGid : "";
      const variantGid = typeof raw.variantGid === "string" ? raw.variantGid : "";

      if (!isProductGid(productGid) || !isVariantGid(variantGid)) {
        errors.offers = `Product ${index + 1} must be a product variant.`;
        return;
      }

      const defaultQuantity = Number(raw.defaultQuantity ?? 1);
      const minQuantity = Number(raw.minQuantity ?? 1);
      const maxQuantity = Number(raw.maxQuantity ?? 10);

      const validQuantity = (value: number) =>
        Number.isInteger(value) && value >= 1 && value <= LIMITS.quantityMax;

      if (
        !validQuantity(defaultQuantity) ||
        !validQuantity(minQuantity) ||
        !validQuantity(maxQuantity) ||
        minQuantity > defaultQuantity ||
        defaultQuantity > maxQuantity
      ) {
        errors.offers =
          `Product ${index + 1} quantities must satisfy 1 ≤ min ≤ default ≤ max ≤ ${LIMITS.quantityMax}.`;
        return;
      }

      offers.push({
        productGid,
        variantGid,
        defaultQuantity,
        minQuantity,
        maxQuantity,
        position: index,
      });
    });

    if (!errors.offers && sources.includes("MANUAL") && rawOffers.length === 0) {
      errors.offers =
        "Add at least one product for the Manual source, or remove Manual from your sources.";
    }
  }

  // Conditions are optional. The wizard submits one root group; an edit of a
  // rule whose stored tree is more advanced sends `conditionsLocked=1` so the
  // tree is never replaced by this flat form.
  const conditionsLocked = form.get("conditionsLocked") === "1";
  const conditionsAllowed = new Set<ConditionField>(STOREFRONT_CONDITION_FIELDS);
  let conditions: ConditionGroupWrite[] | undefined;
  if (!conditionsLocked) {
    const rawConditions = parseJsonArray<RawCondition>(
      String(form.get("conditions") ?? "[]"),
    );
    const joinRaw = text(form, "conditionJoin") || "AND";

    if (rawConditions === null) {
      errors.conditions = "Conditions could not be read. Reload the page.";
    } else if (rawConditions.length > 0) {
      if (joinRaw !== "AND" && joinRaw !== "OR") {
        errors.conditions = "Choose a valid condition join.";
      } else if (rawConditions.length > CONDITION_LIMITS.maxConditions) {
        errors.conditions = `An offer can have at most ${CONDITION_LIMITS.maxConditions} conditions.`;
      } else {
        const normalized: ConditionGroupWrite["conditions"] = [];
        for (const raw of rawConditions) {
          if (
            typeof raw.field !== "string" ||
            !conditionsAllowed.has(raw.field as ConditionField) ||
            typeof raw.operator !== "string"
          ) {
            errors.conditions = "Choose a supported condition field and operator.";
            break;
          }
          try {
            const result = normalizeCondition({
              field: raw.field as ConditionField,
              operator: raw.operator as ConditionOperator,
              value: raw.value,
            });
            normalized.push(result);
          } catch (error) {
            errors.conditions =
              error instanceof InvalidInputError
                ? error.message
                : "A condition is invalid.";
            break;
          }
        }

        if (!errors.conditions) {
          const tree: ConditionGroupWrite[] = [
            { joinOp: joinRaw as "AND" | "OR", conditions: normalized },
          ];
          try {
            validateConditionTree(tree);
            conditions = tree;
          } catch (error) {
            errors.conditions =
              error instanceof InvalidInputError
                ? error.message
                : "The condition tree is invalid.";
          }
        }
      }
    } else {
      conditions = [];
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    input: {
      name,
      description: description || null,
      status: status as RuleStatus,
      priority,
      matchMode: matchMode as MatchMode,
      heading: heading || null,
      maxOffers,
      sources,
      experiences,
      conditions,
      autoLookbackHours,
      autoMaxOffers,
      autoMinRepeats,
      prioritizeRepeats: form.get("prioritizeRepeats") !== null,
      startsAt: startsAt === "invalid" ? null : startsAt,
      endsAt: endsAt === "invalid" ? null : endsAt,
      triggers,
      offers,
    },
  };
}
