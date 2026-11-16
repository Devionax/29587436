import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Shop } from "@prisma/client";
import db from "../db.server";
import { ensureShopInstalled } from "./shop.server";
import { syncEntitlement } from "./entitlement.server";
import type { Entitlement } from "./entitlement.server";
import { authenticate } from "../shopify.server";
import { logger } from "../utils/logger.server";

export type ShopContext = {
  shop: Shop;
  admin: AdminApiContext;
  entitlement: Entitlement;
};

/**
 * Resolves the authenticated tenant for an embedded admin request.
 *
 * The shop domain is taken from the verified Shopify session, never from
 * request parameters. If the tenant row is missing or stale (fresh database,
 * reinstall, or an install that happened before this row existed) it is
 * rebuilt from the Admin API.
 *
 * Plan state is reconciled here because every admin page passes through this
 * function; the entitlement module rate-limits the Shopify call itself.
 */
export async function requireShopContext(request: Request): Promise<ShopContext> {
  const { session, admin } = await authenticate.admin(request);

  let shop = await db.shop.findUnique({ where: { shopDomain: session.shop } });

  if (!shop || shop.installationStatus !== "INSTALLED") {
    logger.info("Tenant row missing or inactive, re-synchronizing", {
      shop: session.shop,
    });
    shop = await ensureShopInstalled(admin, session.shop);
  }

  const entitlement = await syncEntitlement(shop.id, admin);

  return { shop, admin, entitlement };
}
