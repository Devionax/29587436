import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { deleteProductSnapshot, syncProductByGid } from "./catalog.server";
import { logger, toErrorMessage } from "../utils/logger.server";

async function resolveShopId(shopDomain: string): Promise<string | null> {
  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: { id: true, installationStatus: true },
  });

  if (!shop) {
    logger.warn("Product webhook for unknown shop", { shop: shopDomain });
    return null;
  }

  // Webhooks can arrive after uninstall; without a session the Admin API call
  // would fail and make Shopify retry pointlessly.
  if (shop.installationStatus !== "INSTALLED") {
    logger.info("Product webhook for uninstalled shop ignored", {
      shop: shopDomain,
    });
    return null;
  }

  return shop.id;
}

export async function syncProductFromWebhook(
  shopDomain: string,
  productGid: string,
): Promise<void> {
  const shopId = await resolveShopId(shopDomain);
  if (!shopId) return;

  const { admin } = await unauthenticated.admin(shopDomain);
  await syncProductByGid(admin, shopId, productGid);
}

export async function deleteProductFromWebhook(
  shopDomain: string,
  productGid: string,
): Promise<void> {
  const shopId = await resolveShopId(shopDomain);
  if (!shopId) return;

  await deleteProductSnapshot(shopId, productGid);
  logger.info("Product snapshot removed after product delete", {
    shop: shopDomain,
    productGid,
  });
}

export function productGidFromWebhookPayload(
  payload: Record<string, unknown>,
): string | null {
  const graphqlId = payload.admin_graphql_api_id;
  if (typeof graphqlId === "string" && graphqlId.length > 0) {
    return graphqlId;
  }

  const legacyId = payload.id;
  if (typeof legacyId === "number" || typeof legacyId === "string") {
    return `gid://shopify/Product/${legacyId}`;
  }

  return null;
}

export function webhookFailure(
  topic: string,
  shop: string,
  error: unknown,
): Response {
  logger.error("Webhook processing failed", {
    topic,
    shop,
    error: toErrorMessage(error),
  });
  // Non-2xx tells Shopify to retry the delivery.
  return new Response("Webhook processing failed", { status: 500 });
}
