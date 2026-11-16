import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { redactShopData } from "../services/privacy.server";
import {
  beginWebhook,
  completeWebhook,
} from "../services/webhook-receipts.server";
import { logger, toErrorMessage } from "../utils/logger.server";

/**
 * shop/redact — sent 48 hours after uninstall. All tenant data is deleted:
 * settings, rules, offers, product snapshots, analytics, attributions, the
 * subscription cache, sessions and webhook receipts.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, apiVersion } = await authenticate.webhook(request);

  const start = await beginWebhook(shop, topic, webhookId, apiVersion);
  if (start.duplicate) return new Response(null, { status: 200 });

  try {
    // Also removes this receipt; no completion update follows.
    await redactShopData(shop);
  } catch (error) {
    await completeWebhook(start.receiptId, error);
    logger.error("Failed to process shop/redact webhook", {
      shop,
      error: toErrorMessage(error),
    });
    return new Response("Webhook processing failed", { status: 500 });
  }

  return new Response(null, { status: 200 });
};
