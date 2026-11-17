/**
 * HTTP helpers for the checkout extension endpoints.
 *
 * Shopify does not proxy extension network calls, so these routes are called
 * cross-origin from the checkout. JSON responses and auth failures both need
 * CORS headers or the extension only sees a network error.
 */

export function checkoutJson(
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

export function withCheckoutCors(request: Request, response: Response): Response {
  if (!request.headers.get("Origin")) return response;

  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.headers.set("Vary", "Origin");
  return response;
}

/** Empty CORS response for the browser preflight of a cross-origin extension. */
export function checkoutPreflight(request: Request): Response {
  return withCheckoutCors(request, new Response(null, { status: 204 }));
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: "invalid_body" | "payload_too_large" };

/** Reads a JSON body with an explicit size cap; an empty body is `{}`. */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    return { ok: false, status: 413, error: "payload_too_large" };
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  if (body.length > maxBytes) {
    return { ok: false, status: 413, error: "payload_too_large" };
  }
  if (body === "") return { ok: true, value: {} };

  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false, status: 400, error: "invalid_body" };
  }
}

/**
 * Normalizes the session token's `dest` claim into a shop domain.
 * Shopify sends the shop URL; the database stores the bare domain.
 */
export function shopDomainFromDest(dest: unknown): string | null {
  if (typeof dest !== "string" || dest.trim() === "") return null;

  const raw = dest.trim();
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }

  host = host.toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
    host,
  )
    ? host
    : null;
}
