import type { Experience } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { parseStorefrontEventBatch } from "../utils/analytics-input";
import {
  checkoutJson,
  readJsonBody,
  withCheckoutCors,
} from "../utils/checkout-http.server";
import { logger, toErrorMessage } from "../utils/logger.server";
import { checkRateLimit } from "../utils/rate-limit.server";
import { recordStorefrontEvents } from "./analytics.server";
import { resolveCheckoutShop, type CheckoutSessionShop } from "./checkout-session.server";
import { authenticatePostPurchase } from "./post-purchase-auth.server";

/**
 * Ingests analytics from a checkout extension.
 *
 * The extension cannot choose its own surface or experience: both are forced
 * here so a forged payload cannot write rows onto another surface. Events are
 * best effort and never affect the cart or the order.
 */

const MAX_BODY_BYTES = 16_384;

type Respond = (
  body: unknown,
  status?: number,
  headers?: Record<string, string>,
) => Response;

async function ingestBatch(
  request: Request,
  experience: Experience,
  shop: Pick<CheckoutSessionShop, "id" | "shopDomain">,
  respond: Respond,
): Promise<Response> {
  const limit = checkRateLimit(
    `checkout-events:${shop.id}:${experience}`,
    120,
    60_000,
  );
  if (!limit.allowed) {
    return respond({ error: "rate_limited" }, 429, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return respond({ error: body.error }, body.status);

  const events = parseStorefrontEventBatch(body.value).map((event) => ({
    ...event,
    surface: "CHECKOUT" as const,
    experience,
  }));

  if (events.length === 0) {
    return respond({ error: "no_valid_events" }, 400);
  }

  try {
    await recordStorefrontEvents(shop.id, events);
  } catch (error) {
    logger.error("Checkout event ingestion failed", {
      shop: shop.shopDomain,
      experience,
      count: events.length,
      error: toErrorMessage(error),
    });
    return respond({ error: "server_error" }, 500);
  }

  return withCheckoutCors(
    request,
    new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }),
  );
}

export async function ingestCheckoutEvents(
  request: Request,
  experience: Experience,
): Promise<Response> {
  let auth: Awaited<ReturnType<typeof authenticate.public.checkout>>;
  try {
    auth = await authenticate.public.checkout(request);
  } catch (error) {
    if (error instanceof Response) {
      return withCheckoutCors(request, error);
    }
    throw error;
  }

  const respond: Respond = (body, status = 200, headers = {}) =>
    withCheckoutCors(request, auth.cors(checkoutJson(body, status, headers)));

  if (request.method !== "POST") {
    return respond({ error: "method_not_allowed" }, 405);
  }

  const shop = await resolveCheckoutShop(auth.sessionToken.dest);
  if (!shop) {
    return respond({ error: "shop_not_found" }, 404);
  }

  return ingestBatch(request, experience, shop, respond);
}

export async function ingestPostPurchaseEvents(
  request: Request,
): Promise<Response> {
  const result = await authenticatePostPurchase(request);
  if (!result.ok) return result.response;

  return ingestBatch(
    request,
    "POST_PURCHASE",
    result.auth.shop,
    result.auth.respond,
  );
}
