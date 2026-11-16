import db from "../db.server";
import { logger } from "../utils/logger.server";

/**
 * Mandatory privacy webhooks (shop/redact).
 *
 * Deleting the tenant row cascades to settings, rules, triggers, offers,
 * snapshots, analytics, attributions and the subscription cache. Sessions and
 * webhook receipts have no cascade path, so they are removed explicitly.
 * The operation is idempotent: a retried delivery for an already-redacted shop
 * simply deletes nothing.
 */
export async function redactShopData(shopDomain: string): Promise<void> {
  const [, deletedShop] = await db.$transaction([
    db.session.deleteMany({ where: { shop: shopDomain } }),
    db.shop.deleteMany({ where: { shopDomain } }),
    db.webhookReceipt.deleteMany({ where: { shopDomain } }),
  ]);

  logger.info("Shop data redacted", {
    shop: shopDomain,
    deletedTenant: deletedShop.count > 0,
  });
}
