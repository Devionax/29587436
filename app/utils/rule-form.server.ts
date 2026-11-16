import type { MatchMode, RuleStatus } from "@prisma/client";
import type { OfferInput, RuleWriteInput, TriggerInput } from "../services/rules.server";
import { isProductGid, isVariantGid } from "./gid";

/**
 * Parses and validates the rule editor form before anything reaches the
 * service layer. Everything here is untrusted input: browser-supplied shop
 * identity, prices and statuses are never read from the form.
 */

export type RuleFormErrors = Record<string, string>;

export type RuleFormResult =
  | { ok: true; input: RuleWriteInput }
  | { ok: false; errors: RuleFormErrors };

const RULE_STATUSES: RuleStatus[] = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"];
const MATCH_MODES: MatchMode[] = ["ANY", "ALL"];

const LIMITS = {
  name: 120,
  description: 1000,
  heading: 120,
  priorityMax: 100_000,
  triggers: 50,
  offers: 20,
  maxOffersMax: 10,
  quantityMax: 100,
} as const;

type RawTrigger = { productGid?: unknown; variantGid?: unknown };
type RawOffer = {
  productGid?: unknown;
  variantGid?: unknown;
  defaultQuantity?: unknown;
  minQuantity?: unknown;
  maxQuantity?: unknown;
};

function text(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
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

export function parseRuleForm(form: FormData): RuleFormResult {
  const errors: RuleFormErrors = {};

  const name = text(form, "name");
  if (!name) errors.name = "Give the rule a name.";
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

  const showOnProductPage = form.get("showOnProductPage") !== null;
  const showOnCartPage = form.get("showOnCartPage") !== null;
  if (!showOnProductPage && !showOnCartPage) {
    errors.surfaces = "Enable at least one placement.";
  }

  const rawTriggers = parseJsonArray<RawTrigger>(String(form.get("triggers") ?? ""));
  const triggers: TriggerInput[] = [];
  if (rawTriggers === null) {
    errors.triggers = "Trigger products could not be read. Reload the page.";
  } else if (rawTriggers.length === 0) {
    errors.triggers = "Add at least one trigger product.";
  } else if (rawTriggers.length > LIMITS.triggers) {
    errors.triggers = `A rule can have at most ${LIMITS.triggers} trigger products.`;
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

  const rawOffers = parseJsonArray<RawOffer>(String(form.get("offers") ?? ""));
  const offers: OfferInput[] = [];
  if (rawOffers === null) {
    errors.offers = "Offers could not be read. Reload the page.";
  } else if (rawOffers.length === 0) {
    errors.offers = "Add at least one offer product.";
  } else if (rawOffers.length > LIMITS.offers) {
    errors.offers = `A rule can have at most ${LIMITS.offers} offers.`;
  } else {
    rawOffers.forEach((raw, index) => {
      const productGid = typeof raw.productGid === "string" ? raw.productGid : "";
      const variantGid = typeof raw.variantGid === "string" ? raw.variantGid : "";

      if (!isProductGid(productGid) || !isVariantGid(variantGid)) {
        errors.offers = `Offer ${index + 1} must be a product variant.`;
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
          `Offer ${index + 1} quantities must satisfy 1 ≤ min ≤ default ≤ max ≤ ${LIMITS.quantityMax}.`;
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
      showOnProductPage,
      showOnCartPage,
      triggers,
      offers,
    },
  };
}
