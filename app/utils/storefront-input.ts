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

/**
 * The product page block reports which product is being viewed. It is a
 * relevance anchor, not a cart line: it never enables cart-only audiences.
 */
export function parseViewedProduct(
  productRaw: unknown,
  variantRaw: unknown,
): { productGid: string; variantGid: string | null } | null {
  if (typeof productRaw !== "string" || !isProductGid(productRaw)) return null;
  const variantGid =
    typeof variantRaw === "string" && isVariantGid(variantRaw) ? variantRaw : null;
  return { productGid: productRaw, variantGid };
}

const MAX_SUBTOTAL = 100_000_000;

/**
 * The theme reads `items_subtotal_price` from /cart.js (minor units) and sends
 * it in shop currency. It is a relevance hint for subtotal conditions, exactly
 * like cart lines: no price shown to the buyer comes from it.
 */
export function parseSubtotal(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_SUBTOTAL) return null;
  return Math.round(value * 100) / 100;
}

export function parseLoggedIn(raw: unknown): boolean | null {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

const CART_TOKEN = /^[A-Za-z0-9_-]{1,255}$/;

function validToken(value: string | null | undefined): string | null {
  if (!value) return null;
  let token = value;
  try {
    token = decodeURIComponent(value);
  } catch {
    return null;
  }
  // Shopify's cart cookie can carry a query string suffix.
  token = token.split(/[?|]/)[0];
  return CART_TOKEN.test(token) ? token : null;
}

/**
 * The pseudonymous cart token used by the recently-removed source. The cart
 * cookie is set by Shopify on the storefront domain and reaches the app proxy;
 * a query value is accepted only as a relevance hint and is not trusted.
 */
export function readCartToken(request: Request): string | null {
  const url = new URL(request.url);
  const query = validToken(url.searchParams.get("cartToken"));
  if (query) return query;

  const cookie = request.headers.get("cookie");
  if (!cookie) return null;

  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("cart=")) continue;
    return validToken(trimmed.slice("cart=".length));
  }

  return null;
}
