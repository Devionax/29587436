import { Prisma } from "@prisma/client";
import db from "../db.server";

/**
 * Order attribution from the hidden `_scu_offer` line item property.
 *
 * The order payload contains customer data that this app does not need: only the
 * order id, currency, and lines carrying an attribution marker are read. Nothing
 * from the payload is stored except the offer association and its line subtotal.
 */

const OFFER_ID = /^[a-z0-9]{10,40}$/i;
const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

export type AttributedLine = {
  offerId: string;
  variantGid: string;
  quantity: number;
  price: string;
};

export type AttributedOrder = {
  orderGid: string;
  currencyCode: string;
  lines: AttributedLine[];
};

function propertiesOf(line: Record<string, unknown>): Record<string, unknown> {
  const source = line.properties;
  if (Array.isArray(source)) {
    const result: Record<string, unknown> = {};
    for (const entry of source) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.name === "string") result[record.name] = record.value;
    }
    return result;
  }
  if (source && typeof source === "object") {
    return source as Record<string, unknown>;
  }
  return {};
}

/** Returns null when the order carries no marker this app wrote. */
export function attributedOrderFromWebhook(
  payload: Record<string, unknown>,
): AttributedOrder | null {
  const orderGid = payload.admin_graphql_api_id;
  if (typeof orderGid !== "string" || !ORDER_GID.test(orderGid)) return null;

  const currencyCode = payload.currency;
  if (typeof currencyCode !== "string" || currencyCode.length !== 3) return null;

  const lineItems = payload.line_items;
  if (!Array.isArray(lineItems)) return null;

  const lines: AttributedLine[] = [];

  for (const item of lineItems) {
    if (!item || typeof item !== "object") continue;
    const line = item as Record<string, unknown>;
    const properties = propertiesOf(line);

    const offerId = properties._scu_offer;
    if (typeof offerId !== "string" || !OFFER_ID.test(offerId)) continue;

    const variantId = line.variant_id;
    if (typeof variantId !== "number" && typeof variantId !== "string") continue;

    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) continue;

    const price = Number(line.price);
    if (!isFinite(price) || price < 0) continue;

    lines.push({
      offerId,
      variantGid: `gid://shopify/ProductVariant/${variantId}`,
      quantity,
      price: price.toFixed(2),
    });
  }

  if (lines.length === 0) return null;

  return { orderGid, currencyCode, lines };
}

/**
 * Credits offers that belong to the shop and whose variant matches the line that
 * carried the marker. Returns the number of rows inserted.
 */
export async function attributeOrder(
  shopId: string,
  order: AttributedOrder,
): Promise<number> {
  const offerIds = [...new Set(order.lines.map((line) => line.offerId))];
  const offers = await db.recommendedProduct.findMany({
    where: { id: { in: offerIds }, shopId },
    select: { id: true, ruleId: true, productGid: true, variantGid: true },
  });
  const offerById = new Map(offers.map((offer) => [offer.id, offer]));

  const rows: Prisma.OrderAttributionCreateManyInput[] = [];

  for (const line of order.lines) {
    const offer = offerById.get(line.offerId);
    if (!offer || offer.variantGid !== line.variantGid) continue;

    rows.push({
      shopId,
      orderGid: order.orderGid,
      ruleId: offer.ruleId,
      offerProductGid: offer.productGid,
      offerVariantGid: offer.variantGid,
      quantity: line.quantity,
      lineSubtotal: new Prisma.Decimal(line.price).mul(line.quantity),
      currencyCode: order.currencyCode,
    });
  }

  if (rows.length === 0) return 0;

  const result = await db.orderAttribution.createMany({
    data: rows,
    skipDuplicates: true,
  });

  return result.count;
}
