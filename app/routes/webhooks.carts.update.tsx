import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  cartSnapshotFromWebhook,
  recordCartSnapshot,
} from "../services/cart-activity.server";
import { ensureProductSnapshots } from "../services/catalog.server";
import { webhookFailure } from "../services/product-sync.server";
import {
  beginWebhook,
  completeWebhook,
} from "../services/webhook-receipts.server";

/**
 * carts/create and carts/update feed the automatic offer sources. Only the cart
 * token, line product/variant ids and quantities are read; no buyer identity is
 * stored. Custom storefront carts do not send these webhooks.
 *
 * Automatic candidates are rendered from local snapshots, so products seen in
 * cart activity are snapshotted here (bounded) instead of leaving them invisible.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId, apiVersion, admin } =
    await authenticate.webhook(request);

  const start = await beginWebhook(shop, topic, webhookId, apiVersion);
  if (start.duplicate) return new Response(null, { status: 200 });

  const snapshot = cartSnapshotFromWebhook(payload as Record<string, unknown>);
  if (!snapshot) {
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

    const events = await recordCartSnapshot(tenant.id, snapshot);
    const productGids = [
      ...events.map((event) => event.productGid),
      ...snapshot.lines.map((line) => line.productGid),
    ];
    if (admin) {
      await ensureProductSnapshots(admin, tenant.id, productGids, 10);
    }
  } catch (error) {
    await completeWebhook(start.receiptId, error);
    return webhookFailure(topic, shop, error);
  }

  await completeWebhook(start.receiptId);
  return new Response(null, { status: 200 });
};
