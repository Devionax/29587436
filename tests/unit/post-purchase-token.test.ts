import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bearerToken,
  PostPurchaseTokenError,
  signChangesetToken,
  verifyPostPurchaseToken,
} from "../../app/utils/post-purchase-token.server";

const SECRET = "test-api-secret";

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function mint(
  payload: Record<string, unknown>,
  options: {
    secret?: string;
    header?: Record<string, unknown>;
  } = {},
): string {
  const header = base64url(
    JSON.stringify(options.header ?? { alg: "HS256", typ: "JWT" }),
  );
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", options.secret ?? SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "shopify",
    sub: "reference-123",
    iat: Date.now(),
    input_data: {
      shop: { id: 1, domain: "unit-test.myshopify.com" },
      initialPurchase: { referenceId: "reference-123", lineItems: [] },
    },
    ...overrides,
  };
}

function decode(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [header, payload] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  };
}

describe("verifyPostPurchaseToken", () => {
  it("returns the reference and shop from a Shopify-signed token", () => {
    const result = verifyPostPurchaseToken(mint(claims()));

    expect(result.referenceId).toBe("reference-123");
    expect(result.shopDomain).toBe("unit-test.myshopify.com");
    expect(result.inputData).toMatchObject({
      shop: { domain: "unit-test.myshopify.com" },
    });
  });

  it("normalizes a shop URL in the payload", () => {
    const token = mint(
      claims({
        input_data: {
          shop: { domain: "https://URL-Shop.myshopify.com" },
          initialPurchase: {},
        },
      }),
    );

    expect(verifyPostPurchaseToken(token).shopDomain).toBe(
      "url-shop.myshopify.com",
    );
  });

  it("rejects a signature made with another secret", () => {
    expect(() =>
      verifyPostPurchaseToken(mint(claims(), { secret: "other-secret" })),
    ).toThrow(PostPurchaseTokenError);
  });

  it("rejects a token that was not signed with HS256", () => {
    expect(() =>
      verifyPostPurchaseToken(
        mint(claims(), { header: { alg: "none", typ: "JWT" } }),
      ),
    ).toThrow(PostPurchaseTokenError);
  });

  it("rejects a token not issued by Shopify", () => {
    expect(() =>
      verifyPostPurchaseToken(mint(claims({ iss: "partner" }))),
    ).toThrow(PostPurchaseTokenError);
  });

  it("rejects tokens without the required claims", () => {
    expect(() => verifyPostPurchaseToken(mint(claims({ sub: undefined })))).toThrow(
      PostPurchaseTokenError,
    );
    expect(() => verifyPostPurchaseToken(mint(claims({ iat: "now" })))).toThrow(
      PostPurchaseTokenError,
    );
    expect(() =>
      verifyPostPurchaseToken(mint(claims({ input_data: { shop: {} } }))),
    ).toThrow(PostPurchaseTokenError);
    expect(() => verifyPostPurchaseToken(mint(claims({ input_data: null })))).toThrow(
      PostPurchaseTokenError,
    );
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyPostPurchaseToken("")).toThrow(PostPurchaseTokenError);
    expect(() => verifyPostPurchaseToken("a.b")).toThrow(PostPurchaseTokenError);
    expect(() => verifyPostPurchaseToken("a.b.c")).toThrow(PostPurchaseTokenError);
  });
});

describe("bearerToken", () => {
  it("reads a bearer header and ignores other schemes", () => {
    expect(bearerToken("Bearer aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
    expect(bearerToken("Basic aaa.bbb.ccc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("signChangesetToken", () => {
  it("signs the documented changeset claims", () => {
    const token = signChangesetToken("reference-123", [
      { type: "add_variant", variantID: 90201, quantity: 2 },
    ]);
    const { header, payload } = decode(token);

    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({
      iss: "test-api-key",
      sub: "reference-123",
      changes: [{ type: "add_variant", variantID: 90201, quantity: 2 }],
    });
    expect(typeof payload.jti).toBe("string");
    expect(String(payload.jti)).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof payload.iat).toBe("number");

    const [encodedHeader, encodedPayload, signature] = token.split(".");
    const expected = createHmac("sha256", SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest("base64url");
    expect(signature).toBe(expected);
  });

  it("uses a fresh jti for every token", () => {
    const first = decode(
      signChangesetToken("reference-123", [
        { type: "add_variant", variantID: 1, quantity: 1 },
      ]),
    ).payload.jti;
    const second = decode(
      signChangesetToken("reference-123", [
        { type: "add_variant", variantID: 1, quantity: 1 },
      ]),
    ).payload.jti;

    expect(first).not.toBe(second);
  });

  it("refuses a changeset without changes", () => {
    expect(() => signChangesetToken("reference-123", [])).toThrow(
      PostPurchaseTokenError,
    );
  });
});
