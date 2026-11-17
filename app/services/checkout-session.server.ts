import db from "../db.server";
import { shopDomainFromDest } from "../utils/checkout-http.server";

/**
 * Resolves the tenant behind a verified checkout session token.
 *
 * The shop always comes from the signed `dest` claim. An uninstalled shop is
 * treated as unknown so a stale token cannot deliver offers after uninstall.
 */

export type CheckoutSessionShop = {
  id: string;
  shopDomain: string;
  isPlus: boolean;
  ianaTimezone: string | null;
};

export async function resolveCheckoutShop(
  dest: unknown,
): Promise<CheckoutSessionShop | null> {
  const shopDomain = shopDomainFromDest(dest);
  if (!shopDomain) return null;

  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: {
      id: true,
      shopDomain: true,
      isPlus: true,
      ianaTimezone: true,
      installationStatus: true,
    },
  });

  if (!shop || shop.installationStatus !== "INSTALLED") return null;

  return {
    id: shop.id,
    shopDomain: shop.shopDomain,
    isPlus: shop.isPlus,
    ianaTimezone: shop.ianaTimezone,
  };
}
