import { authenticate } from "../shopify.server";
import { getCheckoutOffers } from "./checkout-offers.server";
import { resolveCheckoutShop } from "./checkout-session.server";
import { parseCheckoutContext } from "../utils/checkout-input";
import { checkoutJson, withCheckoutCors } from "../utils/checkout-http.server";
import { logger, toErrorMessage } from "../utils/logger.server";
import { checkRateLimit } from "../utils/rate-limit.server";

/**
 * Handler for POST /api/checkout/offers, used by the pre-purchase extension.
 *
 * It lives outside the route module so the route only exports `action`: the
 * client build strips route exports but not other named exports, and this
 * handler pulls in the server-only Shopify authenticator.
 *
 * The request is authenticated with a Shopify checkout session token; shop and
 * signed-in state come from that token, never from the body.
 */

const MAX_BODY_BYTES = 16_384;

export async function handleCheckoutOffers(request: Request): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authenticate.public.checkout>>;
  try {
    auth = await authenticate.public.checkout(request);
  } catch (error) {
    if (error instanceof Response) {
      return withCheckoutCors(request, error);
    }
    throw error;
  }

  const respond = (body: unknown, status = 200, headers = {}) =>
    withCheckoutCors(request, auth.cors(checkoutJson(body, status, headers)));

  if (request.method !== "POST") {
    return respond({ error: "method_not_allowed" }, 405);
  }

  const shop = await resolveCheckoutShop(auth.sessionToken.dest);
  if (!shop) {
    return respond({ error: "shop_not_found" }, 404);
  }

  const limit = checkRateLimit(`checkout-offers:${shop.id}`, 120, 60_000);
  if (!limit.allowed) {
    return respond({ error: "rate_limited" }, 429, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return respond({ error: "payload_too_large" }, 413);
  }

  let raw: unknown;
  try {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return respond({ error: "payload_too_large" }, 413);
    }
    raw = body === "" ? {} : JSON.parse(body);
  } catch {
    return respond({ error: "invalid_body" }, 400);
  }

  const context = parseCheckoutContext(raw);
  if (!context) {
    return respond({ error: "invalid_body" }, 400);
  }

  context.customerLoggedIn = Boolean(auth.sessionToken.sub);

  try {
    const result = await getCheckoutOffers(shop, "PRE_PURCHASE", context);
    return respond(result);
  } catch (error) {
    logger.error("Checkout offer evaluation failed", {
      shop: shop.shopDomain,
      error: toErrorMessage(error),
    });
    return respond({ error: "server_error" }, 500);
  }
}
