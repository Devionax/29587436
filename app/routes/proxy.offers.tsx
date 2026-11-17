import type { LoaderFunctionArgs } from "react-router";
import { authenticateAppProxy, proxyJson } from "../services/proxy-auth.server";
import { getStorefrontRecommendations } from "../services/recommendations.server";
import { checkRateLimit } from "../utils/rate-limit.server";
import {
  parseCartLines,
  parseLoggedIn,
  parseSubtotal,
  parseSurface,
  parseViewedProduct,
  readCartToken,
} from "../utils/storefront-input";
import { logger, toErrorMessage } from "../utils/logger.server";

/**
 * GET /proxy/offers, reached by buyers as /apps/upsell/offers.
 *
 * The product and cart page blocks call this on load and again after every cart
 * change. The app proxy signature proves the request came from this shop's
 * storefront; the shop is resolved from that signature, never from a parameter.
 * Cart lines, subtotal and signed-in state are relevance hints only — every
 * price, title and availability shown to the buyer comes from product snapshots.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticateAppProxy(request);
  if ("error" in auth) return auth.error;

  const limit = checkRateLimit(`offers:${auth.shop.id}`, 600, 60_000);
  if (!limit.allowed) {
    return proxyJson({ error: "rate_limited" }, 429, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  const url = new URL(request.url);
  const surface = parseSurface(url.searchParams.get("surface"));
  if (!surface) {
    return proxyJson({ error: "invalid_surface" }, 400);
  }

  const cart = parseCartLines(url.searchParams.get("cart"));
  const subtotal = parseSubtotal(url.searchParams.get("subtotal"));
  const customerLoggedIn = parseLoggedIn(url.searchParams.get("loggedIn"));
  const viewedProduct = parseViewedProduct(
    url.searchParams.get("product"),
    url.searchParams.get("variant"),
  );

  try {
    const result = await getStorefrontRecommendations(auth.shop.id, {
      surface,
      cart,
      subtotal,
      customerLoggedIn,
      cartToken: readCartToken(request),
      viewedProduct,
    });

    return proxyJson({
      enabled: result.enabled,
      heading: result.heading,
      offers: result.offers,
    });
  } catch (error) {
    logger.error("Storefront offer evaluation failed", {
      shop: auth.shop.shopDomain,
      surface,
      error: toErrorMessage(error),
    });
    return proxyJson({ error: "server_error" }, 500);
  }
};
