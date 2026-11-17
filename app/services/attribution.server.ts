import { Prisma } from "@prisma/client";
import db from "../db.server";
import { parseSyntheticOfferId } from "../utils/offer-id";

/**
 * Order attribution from the hidden `_scu_offer` line item property.
 *
 * The order payload contains customer data that this app does not need: only the
 * order id, currency, and lines carrying an attribution marker are read. Nothing
 * from the payload is stored except the offer association and its line subtotal.
 */

const OFFER_ID = /^[A-Za-z0-9:_-]{10,120}$/;
const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

export type AttributedLine = {
  offerId: string;
  productGid: string | null;
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

    const productId = line.product_id;
    const productGid =
      typeof productId === "number" || typeof productId === "string"
        ? `gid://shopify/Product/${productId}`
        : null;

    lines.push({
      offerId,
      productGid,
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
 *
 * Automatic offers have no RecommendedProduct row: their marker embeds the rule
 * and product ids, so ownership of the rule and the line's variant/product are
 * verified before a row is written.
 */
export async function attributeOrder(
  shopId: string,
  order: AttributedOrder,
): Promise<number> {
  const offerIds = [...new Set(order.lines.map((line) => line.offerId))];
  const autoByOfferId = new Map<string, NonNullable<ReturnType<typeof parseSyntheticOfferId>>>();
  const autoRuleIds = new Set<string>();

  for (const offerId of offerIds) {
    const auto = parseSyntheticOfferId(offerId);
    if (auto) {
      autoByOfferId.set(offerId, auto);
      autoRuleIds.add(auto.ruleId);
    }
  }

  const [offers, ownedAutoRules] = await Promise.all([
    db.recommendedProduct.findMany({
      where: { id: { in: offerIds }, shopId },
      select: { id: true, ruleId: true, productGid: true, variantGid: true },
    }),
    autoRuleIds.size
      ? db.recommendationRule.findMany({
          where: { id: { in: [...autoRuleIds] }, shopId },
          select: { id: true },
        })
      : [],
  ]);
  const offerById = new Map(offers.map((offer) => [offer.id, offer]));
  const ownedAutoRuleIds = new Set(ownedAutoRules.map((rule) => rule.id));

  const rows: Prisma.OrderAttributionCreateManyInput[] = [];

  for (const line of order.lines) {
    const offer = offerById.get(line.offerId);
    if (offer) {
      if (offer.variantGid !== line.variantGid) continue;
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
      continue;
    }

    const auto = autoByOfferId.get(line.offerId);
    if (!auto || !ownedAutoRuleIds.has(auto.ruleId)) continue;
    if (auto.variantGid !== line.variantGid) continue;
    if (line.productGid && line.productGid !== auto.productGid) continue;

    rows.push({
      shopId,
      orderGid: order.orderGid,
      ruleId: auto.ruleId,
      offerProductGid: auto.productGid,
      offerVariantGid: auto.variantGid,
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
