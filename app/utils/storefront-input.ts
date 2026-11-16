import type { CartLine, Surface } from "../services/recommendation-engine";
import { isProductGid, isVariantGid } from "./gid";

/**
 * Parses storefront-supplied context.
 *
 * The browser sends product/variant identifiers and quantities only. They are
 * treated as relevance hints and never as pricing, identity or permission
 * facts: prices, availability and the shop identity all come from server-side
 * data. Invalid entries are dropped so a malformed request cannot break the
 * merchant's storefront.
 */

const MAX_LINES = 50;
const MAX_RAW_LENGTH = 20_000;
const MAX_QUANTITY = 999;

export function parseCartLines(raw: unknown): CartLine[] {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_LENGTH) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const lines: CartLine[] = [];
  for (const item of parsed.slice(0, MAX_LINES)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;

    const variantGid =
      typeof record.variantGid === "string" && isVariantGid(record.variantGid)
        ? record.variantGid
        : null;
    const productGid =
      typeof record.productGid === "string" && isProductGid(record.productGid)
        ? record.productGid
        : null;
    const quantity = Number(record.quantity);

    if (!variantGid && !productGid) continue;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) continue;

    lines.push({ productGid, variantGid, quantity });
  }

  return lines;
}

export function parseSurface(raw: unknown): Surface | null {
  if (raw === "product") return "PRODUCT_PAGE";
  if (raw === "cart") return "CART_PAGE";
  return null;
}
