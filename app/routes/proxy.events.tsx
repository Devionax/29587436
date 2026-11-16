import type { ActionFunctionArgs } from "react-router";
import { recordStorefrontEvents } from "../services/analytics.server";
import { authenticateAppProxy, proxyJson } from "../services/proxy-auth.server";
import { parseStorefrontEventBatch } from "../utils/analytics-input";
import { logger, toErrorMessage } from "../utils/logger.server";
import { checkRateLimit } from "../utils/rate-limit.server";

/**
 * POST /proxy/events, reached by buyers as /apps/upsell/events.
 *
 * Analytics are best effort: a rejected or dropped event must never affect the
 * cart. The response is empty on success so `navigator.sendBeacon` can fire and
 * forget.
 */

const MAX_BODY_BYTES = 16_384;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return proxyJson({ error: "method_not_allowed" }, 405);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return proxyJson({ error: "payload_too_large" }, 413);
  }

  const auth = await authenticateAppProxy(request);
  if ("error" in auth) return auth.error;

  const limit = checkRateLimit(`events:${auth.shop.id}`, 60, 60_000);
  if (!limit.allowed) {
    return proxyJson({ error: "rate_limited" }, 429, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  let raw: unknown;
  try {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return proxyJson({ error: "payload_too_large" }, 413);
    }
    raw = JSON.parse(body);
  } catch {
    return proxyJson({ error: "invalid_body" }, 400);
  }

  const events = parseStorefrontEventBatch(raw);
  if (events.length === 0) {
    return proxyJson({ error: "no_valid_events" }, 400);
  }

  try {
    await recordStorefrontEvents(auth.shop.id, events);
  } catch (error) {
    logger.error("Storefront event ingestion failed", {
      shop: auth.shop.shopDomain,
      count: events.length,
      error: toErrorMessage(error),
    });
    return proxyJson({ error: "server_error" }, 500);
  }

  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
