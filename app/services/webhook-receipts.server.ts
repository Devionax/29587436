import db from "../db.server";
import { logger, toErrorMessage } from "../utils/logger.server";

/**
 * Webhook idempotency.
 *
 * Shopify retries deliveries and may deliver duplicates. Every handler records
 * the webhook id first; a delivery whose id was already processed is
 * acknowledged without running the handler again. A receipt left in RECEIVED
 * (crash mid-handler) is treated as retryable, not as processed.
 */

export type WebhookStart = {
  duplicate: boolean;
  receiptId: string | null;
};

export async function beginWebhook(
  shopDomain: string,
  topic: string,
  webhookId: string | null | undefined,
  apiVersion?: string | null,
): Promise<WebhookStart> {
  if (!webhookId) return { duplicate: false, receiptId: null };

  try {
    const existing = await db.webhookReceipt.findUnique({ where: { webhookId } });

    if (existing) {
      if (existing.status === "PROCESSED") {
        return { duplicate: true, receiptId: existing.id };
      }
      await db.webhookReceipt.update({
        where: { id: existing.id },
        data: { attempts: { increment: 1 }, status: "RECEIVED" },
      });
      return { duplicate: false, receiptId: existing.id };
    }

    const shop = await db.shop.findUnique({
      where: { shopDomain },
      select: { id: true },
    });

    const receipt = await db.webhookReceipt.create({
      data: {
        webhookId,
        shopDomain,
        shopId: shop?.id ?? null,
        topic,
        apiVersion: apiVersion ?? null,
      },
    });

    return { duplicate: false, receiptId: receipt.id };
  } catch (error) {
    // Receipts are an optimization; failing to write one must not drop a
    // webhook that could otherwise be processed.
    const raced = await db.webhookReceipt
      .findUnique({ where: { webhookId } })
      .catch(() => null);
    logger.warn("Webhook receipt could not be recorded", {
      shop: shopDomain,
      topic,
      error: toErrorMessage(error),
    });
    return { duplicate: raced?.status === "PROCESSED", receiptId: raced?.id ?? null };
  }
}

export async function completeWebhook(
  receiptId: string | null,
  error?: unknown,
): Promise<void> {
  if (!receiptId) return;

  try {
    if (error) {
      await db.webhookReceipt.update({
        where: { id: receiptId },
        data: {
          status: "FAILED",
          lastError: toErrorMessage(error).slice(0, 500),
        },
      });
    } else {
      await db.webhookReceipt.update({
        where: { id: receiptId },
        data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
      });
    }
  } catch (updateError) {
    logger.warn("Webhook receipt could not be updated", {
      error: toErrorMessage(updateError),
    });
  }
}
