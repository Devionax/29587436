import type { CheckoutSessionShop } from "./checkout-session.server";
import { resolveCheckoutShop } from "./checkout-session.server";
import {
  checkoutJson,
  checkoutPreflight,
  readJsonBody,
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

const MAX_AUTH_BODY_BYTES = 8_192;

/**
 * Requests arrive either directly or through the shop's App Proxy. A proxy may
 * drop the Authorization header, so the token may also travel in the JSON
 * body; it is HMAC-verified either way, so a forged body gains nothing.
 */
async function tokenFromBody(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;

  let cloned: Request;
  try {
    cloned = request.clone();
  } catch {
    return null;
  }

  const parsed = await readJsonBody(cloned, MAX_AUTH_BODY_BYTES);
  if (!parsed.ok) return null;

  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const token = (value as Record<string, unknown>).token;
  return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
}

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
    const token =
      bearerToken(request.headers.get("authorization")) ??
      (await tokenFromBody(request));
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
