import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  beginWebhook,
  completeWebhook,
} from "../services/webhook-receipts.server";
import { logger, toErrorMessage } from "../utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop, webhookId, apiVersion } =
    await authenticate.webhook(request);

  logger.info("Received webhook", { topic, shop });

  const start = await beginWebhook(shop, topic, webhookId, apiVersion);
  if (start.duplicate) return new Response(null, { status: 200 });

  const current = payload.current as string[] | undefined;

  try {
    if (session && Array.isArray(current)) {
      await db.session.update({
        where: { id: session.id },
        data: { scope: current.toString() },
      });
    }
  } catch (error) {
    await completeWebhook(start.receiptId, error);
    logger.error("Failed to process app/scopes_update webhook", {
      shop,
      error: toErrorMessage(error),
    });
    return new Response("Webhook processing failed", { status: 500 });
  }

  await completeWebhook(start.receiptId);
  return new Response(null, { status: 200 });
};
