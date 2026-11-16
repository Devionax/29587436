import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  beginWebhook,
  completeWebhook,
} from "../services/webhook-receipts.server";
import { logger } from "../utils/logger.server";

/**
 * customers/redact — the customer asked the merchant to erase their data.
 * Analytics events carry only a pseudonymous session key that is not linked to
 * a customer, so no per-customer records exist to delete. Attribution rows hold
 * an order GID and offer metadata, no customer identity.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, apiVersion } = await authenticate.webhook(request);

  const start = await beginWebhook(shop, topic, webhookId, apiVersion);
  if (start.duplicate) return new Response(null, { status: 200 });

  logger.info("Customer redact acknowledged; no customer PII is stored", {
    shop,
    topic,
  });

  await completeWebhook(start.receiptId);
  return new Response(null, { status: 200 });
};
