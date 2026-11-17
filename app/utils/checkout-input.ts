import type {
  CheckoutContext,
  CheckoutLine,
} from "../services/checkout-offers.server";
import { isProductGid, isVariantGid } from "./gid";

/**
 * Parses the relevance hints a checkout extension sends.
 *
 * Lines carry product/variant identifiers and quantities only. Prices,
 * availability, shop identity and the signed-in state are never taken from
 * this payload: they come from ProductSnapshot or the verified session token.
 * Malformed lines are dropped instead of failing the request.
 */

const MAX_LINES = 50;
const MAX_QUANTITY = 999;
const COUNTRY_CODE = /^[A-Za-z]{2}$/;

function parseLines(raw: unknown): CheckoutLine[] {
  if (!Array.isArray(raw)) return [];

  const lines: CheckoutLine[] = [];
  for (const item of raw.slice(0, MAX_LINES)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;

    const productGid =
      typeof record.productGid === "string" && isProductGid(record.productGid)
        ? record.productGid
        : null;
    if (!productGid) continue;

    const variantGid =
      typeof record.variantGid === "string" && isVariantGid(record.variantGid)
        ? record.variantGid
        : null;
    const quantity = Number(record.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      continue;
    }

    lines.push({ productGid, variantGid, quantity });
  }

  return lines;
}

function parseAmount(raw: unknown): number | null {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function parseCountry(raw: unknown): string | null {
  if (typeof raw !== "string" || !COUNTRY_CODE.test(raw.trim())) return null;
  return raw.trim().toUpperCase();
}

/** Returns null when the body is not an object at all. */
export function parseCheckoutContext(raw: unknown): CheckoutContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  return {
    lines: parseLines(record.lines),
    subtotal: parseAmount(record.subtotal),
    // Filled by the route from the verified session token, never from input.
    customerLoggedIn: null,
    shippingCountry: parseCountry(record.shippingCountry),
    marketCountry:
      parseCountry(record.country) ?? parseCountry(record.marketCountry),
  };
}
