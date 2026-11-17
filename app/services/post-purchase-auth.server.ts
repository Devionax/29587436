import type { CheckoutSessionShop } from "./checkout-session.server";
import { resolveCheckoutShop } from "./checkout-session.server";
import {
  checkoutJson,
  checkoutPreflight,
  withCheckoutCors,
} from "../utils/checkout-http.server";
import { logger, toErrorMessage } from "../utils/logger.server";
import {
  bearerToken,
  PostPurchaseConfigError,
  PostPurchaseTokenError,
  verifyPostPurchaseToken,
  type PostPurchaseClaims,
} from "../utils/post-purchase-token.server";

/**
 * Authentication for the post-purchase extension endpoints.
 *
 * Post-purchase tokens are issued by Shopify for one initial purchase and
 * carry no `dest` claim, so the shop is resolved from the signed payload.
 * Preflight and method rejections are answered here to keep every route on the
 * same CORS contract.
 */

export type PostPurchaseRequestContext = {
  claims: PostPurchaseClaims;
  shop: CheckoutSessionShop;
  respond: (
    body: unknown,
    status?: number,
    headers?: Record<string, string>,
  ) => Response;
};

export type PostPurchaseAuthResult =
  | { ok: true; auth: PostPurchaseRequestContext }
  | { ok: false; response: Response };

export async function authenticatePostPurchase(
  request: Request,
): Promise<PostPurchaseAuthResult> {
  if (request.method === "OPTIONS") {
    return { ok: false, response: checkoutPreflight(request) };
  }

  const respond = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) => withCheckoutCors(request, checkoutJson(body, status, headers));

  if (request.method !== "POST") {
    return { ok: false, response: respond({ error: "method_not_allowed" }, 405) };
  }

  let claims: PostPurchaseClaims;
  try {
    const token = bearerToken(request.headers.get("authorization"));
    if (!token) throw new PostPurchaseTokenError("Missing bearer token");
    claims = verifyPostPurchaseToken(token);
  } catch (error) {
    if (error instanceof PostPurchaseTokenError) {
      return { ok: false, response: respond({ error: "unauthorized" }, 401) };
    }
    if (error instanceof PostPurchaseConfigError) {
      logger.error("Post-purchase token verification is not configured", {
        error: toErrorMessage(error),
      });
      return { ok: false, response: respond({ error: "server_error" }, 500) };
    }
    throw error;
  }

  const shop = await resolveCheckoutShop(claims.shopDomain);
  if (!shop) {
    return { ok: false, response: respond({ error: "shop_not_found" }, 404) };
  }

  return { ok: true, auth: { claims, shop, respond } };
}
