import db from "../db.server";
import { proxiedShopDomain, verifyAppProxyRequest } from "../utils/app-proxy.server";
import { logger } from "../utils/logger.server";

/**
 * Shared authentication for App Proxy routes.
 *
 * Shopify signs the proxied query string; the shop always comes from that signed
 * parameter. Routes must never accept a shop identifier from the body.
 */

export function proxyJson(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

export type ProxyShop = { id: string; shopDomain: string };

export async function authenticateAppProxy(
  request: Request,
): Promise<{ shop: ProxyShop } | { error: Response }> {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    logger.error("App proxy secret is not configured");
    return { error: proxyJson({ error: "not_configured" }, 503) };
  }

  const url = new URL(request.url);
  if (!verifyAppProxyRequest(url, secret)) {
    return { error: proxyJson({ error: "invalid_signature" }, 401) };
  }

  const shopDomain = proxiedShopDomain(url);
  if (!shopDomain) {
    return { error: proxyJson({ error: "missing_shop" }, 400) };
  }

  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: { id: true, shopDomain: true, installationStatus: true },
  });

  if (!shop || shop.installationStatus !== "INSTALLED") {
    return { error: proxyJson({ error: "shop_not_found" }, 404) };
  }

  return { shop: { id: shop.id, shopDomain: shop.shopDomain } };
}
