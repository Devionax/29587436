import type {
  CheckoutContext,
  CheckoutLine,
} from "../services/checkout-offers.server";

/**
 * Builds the evaluation context for a post-purchase offer from the verified
 * Shopify-issued token payload.
 *
 * The payload is signed by Shopify, so unlike the pre-purchase request body it
 * can be trusted. Numeric identifiers are converted to GIDs, and a purchase
 * whose shape is unusable yields null so the caller shows no offer rather than
 * evaluating conditions against invented data.
 */

const MAX_LINES = 200;
const MAX_QUANTITY = 999;
const COUNTRY_CODE = /^[A-Za-z]{2}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Shopify sends numeric IDs; tolerate their string form at the 2^53 limit. */
function numericId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : null;
  }
  return null;
}

function amount(value: unknown): number | null {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0
    ? numeric
    : null;
}

function country(value: unknown): string | null {
  if (typeof value !== "string" || !COUNTRY_CODE.test(value.trim())) return null;
  return value.trim().toUpperCase();
}

function parseLine(item: unknown): CheckoutLine | null {
  const record = asRecord(item);
  const product = record ? asRecord(record.product) : null;
  const productId = product ? numericId(product.id) : null;
  if (!record || !product || !productId) return null;

  const quantity = record.quantity;
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_QUANTITY
  ) {
    return null;
  }

  const variant = asRecord(product.variant);
  const variantId = variant ? numericId(variant.id) : null;

  return {
    productGid: `gid://shopify/Product/${productId}`,
    variantGid: variantId
      ? `gid://shopify/ProductVariant/${variantId}`
      : null,
    quantity,
  };
}

/**
 * `marketCountry` is deliberately null: a post-purchase token identifies the
 * order's destination country, not the market the buyer checked out in, so a
 * MARKET_COUNTRY condition fails closed instead of using the wrong signal.
 */
export function buildPostPurchaseContext(
  inputData: Record<string, unknown>,
): CheckoutContext | null {
  const purchase = asRecord(inputData.initialPurchase);
  if (!purchase) return null;

  const rawLines = Array.isArray(purchase.lineItems) ? purchase.lineItems : [];
  const lines: CheckoutLine[] = [];

  for (const item of rawLines.slice(0, MAX_LINES)) {
    const line = parseLine(item);
    if (line) lines.push(line);
  }

  const total = asRecord(purchase.totalPriceSet);
  const shopMoney = total ? asRecord(total.shopMoney) : null;

  return {
    lines,
    subtotal: null,
    customerLoggedIn:
      typeof purchase.customerId === "string" && purchase.customerId !== "",
    shippingCountry: country(purchase.destinationCountryCode),
    marketCountry: null,
    orderTotal: shopMoney ? amount(shopMoney.amount) : null,
    // The condition counts the whole order, not only the lines we kept.
    orderLineCount: rawLines.length,
  };
}
