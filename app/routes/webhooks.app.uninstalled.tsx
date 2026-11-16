import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markShopUninstalled } from "../services/shop.server";
import {
  beginWebhook,
  completeWebhook,
} from "../services/webhook-receipts.server";
import { logger, toErrorMessage } from "../utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, apiVersion } =
    await authenticate.webhook(request);

  logger.info("Received webhook", { topic, shop });

  const start = await beginWebhook(shop, topic, webhookId, apiVersion);
  if (start.duplicate) return new Response(null, { status: 200 });

  try {
    // Sessions are useless after uninstall and must not linger.
    await db.session.deleteMany({ where: { shop } });

    // Merchant data is retained here so a reinstall keeps its configuration.
    // The mandatory shop/redact webhook deletes it when Shopify asks.
    await markShopUninstalled(shop);
  } catch (error) {
    await completeWebhook(start.receiptId, error);
    logger.error("Failed to process app/uninstalled webhook", {
      shop,
      error: toErrorMessage(error),
    });
    // Non-2xx makes Shopify retry the webhook.
    return new Response("Webhook processing failed", { status: 500 });
  }

  await completeWebhook(start.receiptId);
  return new Response(null, { status: 200 });
};
