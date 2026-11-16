import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  productGidFromWebhookPayload,
  syncProductFromWebhook,
  webhookFailure,
} from "../services/product-sync.server";
import {
  beginWebhook,
  completeWebhook,
} from "../services/webhook-receipts.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId, apiVersion } =
    await authenticate.webhook(request);

  const start = await beginWebhook(shop, topic, webhookId, apiVersion);
  if (start.duplicate) return new Response(null, { status: 200 });

  const productGid = productGidFromWebhookPayload(
    payload as Record<string, unknown>,
  );

  if (!productGid) {
    await completeWebhook(start.receiptId);
    return new Response(null, { status: 200 });
  }

  try {
    // Re-fetches from the Admin API instead of trusting the webhook payload,
    // so availability and prices match Shopify at sync time.
    await syncProductFromWebhook(shop, productGid);
  } catch (error) {
    await completeWebhook(start.receiptId, error);
    return webhookFailure(topic, shop, error);
  }

  await completeWebhook(start.receiptId);
  return new Response(null, { status: 200 });
};
