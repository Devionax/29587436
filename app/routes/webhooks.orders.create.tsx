import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  attributeOrder,
  attributedOrderFromWebhook,
} from "../services/attribution.server";
import { webhookFailure } from "../services/product-sync.server";
import {
  beginWebhook,
  completeWebhook,
} from "../services/webhook-receipts.server";

/**
 * orders/create is the only source of confirmed purchases. The handler reads
 * nothing but the order id, currency and lines this app tagged, then discards the
 * payload. Order data is protected customer data; see README for the approval
 * requirement before public distribution.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId, apiVersion } =
    await authenticate.webhook(request);

  const start = await beginWebhook(shop, topic, webhookId, apiVersion);
  if (start.duplicate) return new Response(null, { status: 200 });

  const order = attributedOrderFromWebhook(payload as Record<string, unknown>);
  if (!order) {
    // Not an order that used the upsell block; acknowledge and stop.
    await completeWebhook(start.receiptId);
    return new Response(null, { status: 200 });
  }

  try {
    const tenant = await db.shop.findUnique({
      where: { shopDomain: shop },
      select: { id: true, installationStatus: true },
    });

    if (!tenant || tenant.installationStatus !== "INSTALLED") {
      await completeWebhook(start.receiptId);
      return new Response(null, { status: 200 });
    }

    await attributeOrder(tenant.id, order);
  } catch (error) {
    await completeWebhook(start.receiptId, error);
    return webhookFailure(topic, shop, error);
  }

  await completeWebhook(start.receiptId);
  return new Response(null, { status: 200 });
};
