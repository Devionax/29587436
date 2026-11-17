import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { shopDomainFromDest } from "./checkout-http.server";

/**
 * Post-purchase tokens are not admin session tokens: they carry the purchase
 * payload Shopify handed to the extension, signed with the app secret, and
 * have no `dest` claim. Both directions are handled here with node:crypto so
 * the app adds no JWT dependency.
 *
 * https://shopify.dev/docs/api/checkout-extensions/post-purchase/jwt-specification
 */

const MAX_TOKEN_LENGTH = 16_384;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export class PostPurchaseTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostPurchaseTokenError";
  }
}

/** Credentials are missing; this is a deployment fault, not a bad request. */
export class PostPurchaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostPurchaseConfigError";
  }
}

export type PostPurchaseClaims = {
  /** Token `sub`: the initial purchase reference id. */
  referenceId: string;
  /** Shop domain taken from the signed payload. */
  shopDomain: string;
  inputData: Record<string, unknown>;
};

export type ChangesetChange = {
  type: "add_variant";
  variantID: number;
  quantity: number;
};

function appSecret(): string {
  const value = process.env.SHOPIFY_API_SECRET;
  if (!value) {
    throw new PostPurchaseConfigError("SHOPIFY_API_SECRET is not configured");
  }
  return value;
}

function appKey(): string {
  const value = process.env.SHOPIFY_API_KEY;
  if (!value) {
    throw new PostPurchaseConfigError("SHOPIFY_API_KEY is not configured");
  }
  return value;
}

function sign(input: string): Buffer {
  return createHmac("sha256", appSecret()).update(input).digest();
}

function decodeSegment(segment: string, label: string): Record<string, unknown> {
  if (!SEGMENT.test(segment)) {
    throw new PostPurchaseTokenError(`Malformed token ${label}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new PostPurchaseTokenError(`Malformed token ${label}`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PostPurchaseTokenError(`Malformed token ${label}`);
  }
  return value as Record<string, unknown>;
}

/** Reads the bearer token from an Authorization header. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
    header.trim(),
  );
  return match ? match[1] : null;
}

/**
 * Verifies a token Shopify issued to the post-purchase extension and returns
 * the purchase reference and shop. Throws PostPurchaseTokenError for anything
 * that is not a well-formed Shopify-issued token.
 */
export function verifyPostPurchaseToken(token: string): PostPurchaseClaims {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    throw new PostPurchaseTokenError("Missing token");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new PostPurchaseTokenError("Malformed token");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeSegment(encodedHeader, "header");
  if (header.alg !== "HS256") {
    throw new PostPurchaseTokenError("Unsupported token algorithm");
  }

  const expected = sign(`${encodedHeader}.${encodedPayload}`);
  if (!SEGMENT.test(encodedSignature)) {
    throw new PostPurchaseTokenError("Malformed token signature");
  }
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PostPurchaseTokenError("Invalid token signature");
  }

  const payload = decodeSegment(encodedPayload, "payload");
  if (payload.iss !== "shopify") {
    throw new PostPurchaseTokenError("Token was not issued by Shopify");
  }
  if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
    throw new PostPurchaseTokenError("Token is missing the purchase reference");
  }
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
    throw new PostPurchaseTokenError("Token is missing its issue time");
  }

  const inputData = payload.input_data;
  if (!inputData || typeof inputData !== "object" || Array.isArray(inputData)) {
    throw new PostPurchaseTokenError("Token is missing the purchase payload");
  }

  const shop = (inputData as Record<string, unknown>).shop;
  const domain =
    shop && typeof shop === "object" && !Array.isArray(shop)
      ? (shop as Record<string, unknown>).domain
      : null;
  const shopDomain = shopDomainFromDest(domain);
  if (!shopDomain) {
    throw new PostPurchaseTokenError("Token is missing the shop domain");
  }

  return {
    referenceId: payload.sub,
    shopDomain,
    inputData: inputData as Record<string, unknown>,
  };
}

/**
 * Signs the changeset the extension applies with `applyChangeset`.
 *
 * Claims follow Shopify's post-purchase JWT specification: `jti` makes each
 * token unique, `iss` is the app's API key and `sub` is the initial purchase
 * reference. The `iat` unit matches Shopify's published signing sample.
 */
export function signChangesetToken(
  referenceId: string,
  changes: ChangesetChange[],
): string {
  if (!referenceId) {
    throw new PostPurchaseTokenError("A purchase reference is required");
  }
  if (changes.length === 0) {
    throw new PostPurchaseTokenError("A changeset needs at least one change");
  }

  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: appKey(),
      jti: randomUUID(),
      iat: Date.now(),
      sub: referenceId,
      changes,
    }),
  ).toString("base64url");

  return `${header}.${payload}.${sign(`${header}.${payload}`).toString("base64url")}`;
}
