import crypto from "node:crypto";

/**
 * App Proxy request verification.
 *
 * Shopify signs the query string of every proxied request with the app secret:
 * parameters are sorted, rendered as `key=value` and concatenated with no
 * separator, then HMAC-SHA256 hashed and hex encoded. Repeated parameters are
 * joined with commas, matching Shopify's documented example. The `signature`
 * parameter itself is excluded.
 *
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 */

export function computeAppProxySignature(
  searchParams: URLSearchParams,
  secret: string,
): string {
  const pairs: string[] = [];

  const keys = new Set<string>();
  searchParams.forEach((_value, key) => keys.add(key));
  keys.delete("signature");

  for (const key of keys) {
    const values = searchParams.getAll(key);
    pairs.push(`${key}=${values.join(",")}`);
  }

  pairs.sort();

  return crypto
    .createHmac("sha256", secret)
    .update(pairs.join(""))
    .digest("hex");
}

export function verifyAppProxyRequest(url: URL, secret: string): boolean {
  const provided = url.searchParams.get("signature");
  if (!provided || !secret) return false;

  const expected = computeAppProxySignature(url.searchParams, secret);
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/** Shopify adds `shop` to every proxied request; the signature covers it. */
export function proxiedShopDomain(url: URL): string | null {
  const shop = url.searchParams.get("shop");
  return shop ? shop.toLowerCase() : null;
}
