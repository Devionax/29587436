import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { action as offersAction } from "../../app/routes/api.checkout.offers";
import { action as eventsAction } from "../../app/routes/api.checkout.events";
import { upsertProductSnapshot } from "../../app/services/catalog.server";
import type { CatalogProduct } from "../../app/services/catalog.server";
import { createRule } from "../../app/services/rules.server";
import { DEFAULT_SETTINGS, updateSettings } from "../../app/services/settings.server";
import { resetRateLimits } from "../../app/utils/rate-limit.server";
import { createShop, prisma } from "../helpers/db";

/**
 * Route tests for the pre-purchase extension endpoints.
 *
 * Session tokens are minted the way Shopify mints them (HS256 over the app
 * secret). No test calls Shopify.
 */

const SECRET = "test-api-secret";
const TRIGGER = "gid://shopify/Product/801";
const OFFER = "gid://shopify/Product/802";
const OFFER_VARIANT = "gid://shopify/ProductVariant/80201";

const shops: string[] = [];

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function sessionToken(
  dest: string,
  overrides: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: `${dest}/admin`,
      dest,
      aud: "test-api-key",
      sub: "gid://shopify/Customer/9",
      exp: now + 300,
      nbf: now - 10,
      iat: now,
      jti: randomUUID(),
      ...overrides,
    }),
  );
  const signature = createHmac("sha256", SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function request(
  path: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    origin?: string | null;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.origin) headers.Origin = options.origin;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  return new Request(`https://test-app.example${path}`, {
    method: options.method ?? "POST",
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body),
  });
}

function snapshot(): CatalogProduct {
  return {
    productGid: OFFER,
    title: "Cleaning spray",
    handle: "cleaning-spray",
    status: "ACTIVE",
    imageUrl: null,
    availableForSale: true,
    priceMin: "12.00",
    priceMax: "12.00",
    currencyCode: "USD",
    variants: [
      {
        variantGid: OFFER_VARIANT,
        title: "Default",
        price: "12.00",
        compareAtPrice: null,
        availableForSale: true,
        position: 0,
      },
    ],
  };
}

let shop: Awaited<ReturnType<typeof createShop>>;
let offerId: string;
let ruleId: string;

async function callOffers(
  options: Parameters<typeof request>[1] = {},
): Promise<Response> {
  return offersAction({
    request: request("/api/checkout/offers", options),
  } as never) as Promise<Response>;
}

beforeAll(async () => {
  shop = await createShop("checkout-api");
  shops.push(shop.id);
  await prisma.shop.update({ where: { id: shop.id }, data: { isPlus: true } });
  await updateSettings(shop.id, { ...DEFAULT_SETTINGS, enabled: true });
  await upsertProductSnapshot(shop.id, snapshot());

  const rule = await createRule(shop.id, {
    name: "Checkout route rule",
    status: "ACTIVE",
    priority: 10,
    matchMode: "ANY",
    heading: "Pairs with your purchase",
    triggers: [{ productGid: TRIGGER }],
    offers: [{ productGid: OFFER, variantGid: OFFER_VARIANT }],
    experiences: [
      {
        experience: "PRE_PURCHASE",
        enabled: true,
        headline: null,
        body: null,
        ctaLabel: null,
      },
    ],
  });
  offerId = rule.offers[0].id;
  ruleId = rule.id;
});

afterEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: shops } } });
  await prisma.$disconnect();
});

describe("POST /api/checkout/offers", () => {
  it("returns offers for a signed extension request", async () => {
    const response = await callOffers({
      token: sessionToken(`https://${shop.shopDomain}`),
      origin: "https://checkout.shopify.com",
      body: {
        lines: [{ productGid: TRIGGER, variantGid: null, quantity: 1 }],
        subtotal: 80,
        country: "US",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = await response.json();
    expect(body.enabled).toBe(true);
    expect(body.heading).toBe("Pairs with your purchase");
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]).toMatchObject({
      id: offerId,
      variantGid: OFFER_VARIANT,
      ctaLabel: "Add to cart",
    });
  });

  it("rejects a missing token", async () => {
    const response = await callOffers({
      body: { lines: [] },
    });

    expect(response.status).toBe(401);
  });

  it("rejects a tampered signature", async () => {
    const token = sessionToken(`https://${shop.shopDomain}`);
    const [header, payload] = token.split(".");
    const tampered = `${header}.${payload}.${base64url("forged")}`;

    const response = await callOffers({ token: tampered, body: { lines: [] } });
    expect(response.status).toBe(401);
  });

  it("answers the CORS preflight", async () => {
    const response = await callOffers({
      method: "OPTIONS",
      token: sessionToken(`https://${shop.shopDomain}`),
      origin: "https://checkout.shopify.com",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects a method other than POST", async () => {
    const response = await callOffers({
      method: "GET",
      token: sessionToken(`https://${shop.shopDomain}`),
    });

    expect(response.status).toBe(405);
  });

  it("rejects malformed JSON", async () => {
    const response = await callOffers({
      token: sessionToken(`https://${shop.shopDomain}`),
      body: "{",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_body");
  });

  it("does not serve an unknown shop", async () => {
    const response = await callOffers({
      token: sessionToken("https://unknown-shop.myshopify.com"),
      body: { lines: [] },
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("shop_not_found");
  });

  it("does not serve an uninstalled shop", async () => {
    const gone = await createShop("checkout-api-gone");
    shops.push(gone.id);
    await prisma.shop.update({
      where: { id: gone.id },
      data: { installationStatus: "UNINSTALLED" },
    });

    const response = await callOffers({
      token: sessionToken(`https://${gone.shopDomain}`),
      body: { lines: [] },
    });

    expect(response.status).toBe(404);
  });

  it("throttles a checkout that floods the endpoint", async () => {
    const flood = await createShop("checkout-api-flood");
    shops.push(flood.id);
    await updateSettings(flood.id, { ...DEFAULT_SETTINGS, enabled: true });
    const token = sessionToken(`https://${flood.shopDomain}`);

    for (let index = 0; index < 120; index += 1) {
      const response = await callOffers({ token, body: { lines: [] } });
      expect(response.status).toBe(200);
    }

    const response = await callOffers({ token, body: { lines: [] } });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("POST /api/checkout/events", () => {
  async function callEvents(options: Parameters<typeof request>[1] = {}) {
    return eventsAction({
      request: request("/api/checkout/events", options),
    } as never) as Promise<Response>;
  }

  it("forces the checkout surface and pre-purchase experience", async () => {
    const response = await callEvents({
      token: sessionToken(`https://${shop.shopDomain}`),
      body: {
        events: [
          {
            eventType: "IMPRESSION",
            surface: "cart",
            experience: "POST_PURCHASE",
            offerId,
            sessionKey: "session-key-123",
            dedupeKey: "forced-experience",
          },
        ],
      },
    });

    expect(response.status).toBe(204);

    const row = await prisma.analyticsEvent.findUnique({
      where: { dedupeKey: `${shop.id}:forced-experience` },
    });
    expect(row).toMatchObject({
      shopId: shop.id,
      ruleId,
      eventType: "IMPRESSION",
      surface: "CHECKOUT",
      experience: "PRE_PURCHASE",
    });
  });

  it("drops an offer id that belongs to another shop", async () => {
    const other = await createShop("checkout-api-other");
    shops.push(other.id);
    await upsertProductSnapshot(other.id, snapshot());
    const foreignRule = await createRule(other.id, {
      name: "Foreign rule",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      triggers: [{ productGid: TRIGGER }],
      offers: [{ productGid: OFFER, variantGid: OFFER_VARIANT }],
    });

    const response = await callEvents({
      token: sessionToken(`https://${shop.shopDomain}`),
      body: {
        events: [
          {
            eventType: "IMPRESSION",
            surface: "checkout",
            experience: "PRE_PURCHASE",
            offerId: foreignRule.offers[0].id,
            sessionKey: "session-key-456",
            dedupeKey: "foreign-offer",
          },
        ],
      },
    });

    expect(response.status).toBe(204);
    expect(
      await prisma.analyticsEvent.findUnique({
        where: { dedupeKey: `${shop.id}:foreign-offer` },
      }),
    ).toBeNull();
  });

  it("rejects an unsigned request", async () => {
    const response = await callEvents({ body: { events: [] } });
    expect(response.status).toBe(401);
  });

  it("rejects a batch with no valid events", async () => {
    const response = await callEvents({
      token: sessionToken(`https://${shop.shopDomain}`),
      body: { events: [{ eventType: "NOPE" }] },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("no_valid_events");
  });
});
