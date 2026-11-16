import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  beginWebhook,
  completeWebhook,
} from "../services/webhook-receipts.server";
import { logger } from "../utils/logger.server";

/**
 * customers/data_request — Shopify asks for any data the app holds about a
 * customer. This app stores only pseudonymous storefront session keys and
 * offer attribution; it never stores names, emails, addresses or customer ids,
 * so there is nothing to disclose or forward to the merchant.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, apiVersion } = await authenticate.webhook(request);

  const start = await beginWebhook(shop, topic, webhookId, apiVersion);
  if (start.duplicate) return new Response(null, { status: 200 });

  logger.info("Customer data request acknowledged; no customer PII is stored", {
    shop,
    topic,
  });

  await completeWebhook(start.receiptId);
  return new Response(null, { status: 200 });
};
