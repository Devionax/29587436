import type { LoaderFunctionArgs } from "react-router";
import type { Recommendation } from "../services/recommendation-engine";
import { getStorefrontRecommendations } from "../services/recommendations.server";
import { authenticateAppProxy, proxyJson } from "../services/proxy-auth.server";
import { logger, toErrorMessage } from "../utils/logger.server";
import { checkRateLimit } from "../utils/rate-limit.server";
import { parseCartLines, parseSurface } from "../utils/storefront-input";

/**
 * GET /proxy/offers, reached by buyers as /apps/upsell/offers.
 *
 * The shop is taken from Shopify's signed `shop` parameter, never from the
 * request body. Rule names, priorities and exclusion reasons are internal and
 * are not part of the response.
 */

function publicOffer(offer: Recommendation) {
  return {
    ruleId: offer.ruleId,
    offerId: offer.offerId,
    productGid: offer.productGid,
    variantGid: offer.variantGid,
    productTitle: offer.productTitle,
    variantTitle: offer.variantTitle,
    handle: offer.handle,
    imageUrl: offer.imageUrl,
    price: offer.price,
    compareAtPrice: offer.compareAtPrice,
    currencyCode: offer.currencyCode,
    defaultQuantity: offer.defaultQuantity,
    minQuantity: offer.minQuantity,
    maxQuantity: offer.maxQuantity,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticateAppProxy(request);
  if ("error" in auth) return auth.error;

  const limit = checkRateLimit(`offers:${auth.shop.id}`, 120, 60_000);
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

  try {
    const result = await getStorefrontRecommendations(auth.shop.id, {
      surface,
      cart: parseCartLines(url.searchParams.get("cart")),
    });

    return proxyJson({
      enabled: result.enabled,
      heading: result.heading,
      offers: result.offers.map(publicOffer),
    });
  } catch (error) {
    logger.error("Storefront offer request failed", {
      shop: auth.shop.shopDomain,
      surface,
      error: toErrorMessage(error),
    });
    return proxyJson({ error: "server_error" }, 500);
  }
};
