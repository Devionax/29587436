import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Shop } from "@prisma/client";
import db from "../db.server";
import { logger } from "../utils/logger.server";

// field names verified against Admin API 2026-10; publicDisplayName replaces deprecated displayName
const SHOP_IDENTITY_QUERY = `#graphql
  query ShopIdentity {
    shop {
      name
      myshopifyDomain
      currencyCode
      plan {
        publicDisplayName
        shopifyPlus
      }
    }
  }
`;

type ShopIdentityResponse = {
  data?: {
    shop?: {
      name: string;
      myshopifyDomain: string;
      currencyCode: string;
      plan: {
        publicDisplayName: string;
        shopifyPlus: boolean;
      };
    };
  };
  errors?: Array<{ message: string }>;
};

export type ShopIdentity = {
  name: string | null;
  currencyCode: string | null;
  planName: string | null;
  isPlus: boolean;
};

export async function fetchShopIdentity(
  admin: AdminApiContext,
): Promise<ShopIdentity> {
  const response = await admin.graphql(SHOP_IDENTITY_QUERY);
  const body = (await response.json()) as ShopIdentityResponse;

  if (body.errors?.length) {
    throw new Error(
      `Shop identity query failed: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const shop = body.data?.shop;
  if (!shop) {
    throw new Error("Shop identity query returned no shop");
  }

  return {
    name: shop.name ?? null,
    currencyCode: shop.currencyCode ?? null,
    planName: shop.plan?.publicDisplayName ?? null,
    isPlus: Boolean(shop.plan?.shopifyPlus),
  };
}

/**
 * Creates or refreshes the tenant row for an authenticated shop.
 * Only call this with a shop domain that came from a verified Shopify session
 * or a verified webhook, never from a request body.
 */
export async function ensureShopInstalled(
  admin: AdminApiContext,
  shopDomain: string,
): Promise<Shop> {
  const identity = await fetchShopIdentity(admin);
  const existing = await db.shop.findUnique({ where: { shopDomain } });

  const now = new Date();
  const reinstalled = existing?.installationStatus === "UNINSTALLED";

  const shop = await db.shop.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      name: identity.name,
      currencyCode: identity.currencyCode,
      shopifyPlan: identity.planName,
      isPlus: identity.isPlus,
      installationStatus: "INSTALLED",
      installedAt: now,
    },
    update: {
      name: identity.name,
      currencyCode: identity.currencyCode,
      shopifyPlan: identity.planName,
      isPlus: identity.isPlus,
      installationStatus: "INSTALLED",
      installedAt: reinstalled || !existing?.installedAt ? now : existing.installedAt,
      uninstalledAt: null,
    },
  });

  await db.shopSettings.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id },
    update: {},
  });

  logger.info("Shop tenant synchronized", {
    shop: shop.shopDomain,
    isPlus: shop.isPlus,
    plan: shop.shopifyPlan,
    reinstall: Boolean(reinstalled),
  });

  return shop;
}

/**
 * Marks a tenant as uninstalled. Called from the app/uninstalled webhook.
 * Records are retained until the retention policy in privacy.server runs;
 * we never delete merchant configuration on uninstall without that policy.
 */
export async function markShopUninstalled(shopDomain: string): Promise<void> {
  const result = await db.shop.updateMany({
    where: { shopDomain, installationStatus: "INSTALLED" },
    data: { installationStatus: "UNINSTALLED", uninstalledAt: new Date() },
  });

  if (result.count === 0) {
    logger.warn("Uninstall webhook for shop without installed tenant row", {
      shop: shopDomain,
    });
    return;
  }

  logger.info("Shop marked uninstalled", { shop: shopDomain });
}
