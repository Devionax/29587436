import { getCheckoutOffers } from "./checkout-offers.server";
import { authenticatePostPurchase } from "./post-purchase-auth.server";
import { buildPostPurchaseContext } from "../utils/post-purchase-input";
import { readJsonBody } from "../utils/checkout-http.server";
import {
  signChangesetToken,
  type ChangesetChange,
} from "../utils/post-purchase-token.server";
import { checkRateLimit } from "../utils/rate-limit.server";
import { logger, toErrorMessage } from "../utils/logger.server";

/**
 * Handlers for the post-purchase extension endpoints.
 *
 * They live outside the route modules so those routes only export `action`;
 * the client build strips route exports but not other named exports, and the
 * handlers pull in server-only code.
 */

const CHANGESET_MAX_BODY_BYTES = 4_096;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/(\d{1,20})$/;

function variantIdFromGid(gid: string): number | null {
  const match = VARIANT_GID.exec(gid);
  if (!match) return null;
  const numeric = Number(match[1]);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * POST /api/post-purchase/offers — called from `ShouldRender`.
 *
 * The request body is not used: the purchase comes from the Shopify-signed
 * token, so a forged payload cannot change the total, lines or country used by
 * conditions.
 */
export async function handlePostPurchaseOffers(
  request: Request,
): Promise<Response> {
  const result = await authenticatePostPurchase(request);
  if (!result.ok) return result.response;
  const { shop, claims, respond } = result.auth;

  const limit = checkRateLimit(
    `post-purchase-offers:${shop.id}:${claims.referenceId}`,
    120,
    60_000,
  );
  if (!limit.allowed) {
    return respond({ error: "rate_limited" }, 429, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  const context = buildPostPurchaseContext(claims.inputData);
  if (!context) {
    return respond({ enabled: false, heading: null, offers: [] });
  }

  try {
    return respond(await getCheckoutOffers(shop, "POST_PURCHASE", context));
  } catch (error) {
    logger.error("Post-purchase offer evaluation failed", {
      shop: shop.shopDomain,
      error: toErrorMessage(error),
    });
    return respond({ error: "server_error" }, 500);
  }
}

/**
 * POST /api/post-purchase/changeset — signs the change the extension applies
 * with `applyChangeset`.
 *
 * The requested offer is re-evaluated against the token's purchase first, so
 * only an offer that is still active, available and shown for this purchase can
 * be signed; the quantity and variant come from the server, never the request.
 */
export async function handlePostPurchaseChangeset(
  request: Request,
): Promise<Response> {
  const result = await authenticatePostPurchase(request);
  if (!result.ok) return result.response;
  const { shop, claims, respond } = result.auth;

  const limit = checkRateLimit(
    `post-purchase-changeset:${shop.id}:${claims.referenceId}`,
    20,
    60_000,
  );
  if (!limit.allowed) {
    return respond({ error: "rate_limited" }, 429, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  const body = await readJsonBody(request, CHANGESET_MAX_BODY_BYTES);
  if (!body.ok) return respond({ error: body.error }, body.status);

  const record =
    body.value && typeof body.value === "object" && !Array.isArray(body.value)
      ? (body.value as Record<string, unknown>)
      : null;
  const offerId = record?.offerId;
  if (typeof offerId !== "string" || offerId.trim() === "") {
    return respond({ error: "invalid_body" }, 400);
  }

  const context = buildPostPurchaseContext(claims.inputData);
  if (!context) {
    return respond({ error: "invalid_purchase" }, 400);
  }

  try {
    const evaluation = await getCheckoutOffers(shop, "POST_PURCHASE", context);
    if (!evaluation.enabled) {
      return respond({ error: "offers_disabled" }, 409);
    }

    const offer = evaluation.offers.find((entry) => entry.id === offerId);
    if (!offer) {
      return respond({ error: "offer_not_available" }, 404);
    }

    const variantId = variantIdFromGid(offer.variantGid);
    if (!variantId) {
      return respond({ error: "offer_not_available" }, 409);
    }

    const changes: ChangesetChange[] = [
      { type: "add_variant", variantID: variantId, quantity: offer.quantity },
    ];

    return respond({ token: signChangesetToken(claims.referenceId, changes) });
  } catch (error) {
    logger.error("Post-purchase changeset signing failed", {
      shop: shop.shopDomain,
      offerId,
      error: toErrorMessage(error),
    });
    return respond({ error: "server_error" }, 500);
  }
}
