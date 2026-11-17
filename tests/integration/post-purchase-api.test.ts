import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { action as changesetAction } from "../../app/routes/api.post-purchase.changeset";
import { action as eventsAction } from "../../app/routes/api.post-purchase.events";
import { action as offersAction } from "../../app/routes/api.post-purchase.offers";
import type { CatalogProduct } from "../../app/services/catalog.server";
import { upsertProductSnapshot } from "../../app/services/catalog.server";
import { createRule } from "../../app/services/rules.server";
import {
  DEFAULT_SETTINGS,
  updateSettings,
} from "../../app/services/settings.server";
import { resetRateLimits } from "../../app/utils/rate-limit.server";
import { createShop, prisma } from "../helpers/db";

/**
 * Route tests for the post-purchase extension endpoints.
 *
 * Tokens are minted the way Shopify mints them: HS256 over the app secret with
 * the purchase payload under `input_data`. No test calls Shopify.
 */

const SECRET = "test-api-secret";
const PURCHASED_PRODUCT = 901;
const PURCHASED_VARIANT = 90101;
const OFFER_PRODUCT = "gid://shopify/Product/902";
const OFFER_VARIANT = "gid://shopify/ProductVariant/90201";

const shops: string[] = [];

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function tokenFor(
  shopDomain: string,
  options: {
    referenceId?: string;
    purchase?: Record<string, unknown>;
  } = {},
): string {
  const referenceId = options.referenceId ?? "reference-1";
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: "shopify",
      sub: referenceId,
      iat: Date.now(),
      input_data: {
        shop: { id: 1, domain: shopDomain },
        initialPurchase: {
          referenceId,
          customerId: "buyer-1",
          destinationCountryCode: "US",
          totalPriceSet: { shopMoney: { amount: "80.00", currencyCode: "USD" } },
          lineItems: [
            {
              product: { id: PURCHASED_PRODUCT, variant: { id: PURCHASED_VARIANT } },
              quantity: 1,
            },
          ],
          ...options.purchase,
        },
      },
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
    productGid: OFFER_PRODUCT,
    title: "Gift wrap",
    handle: "gift-wrap",
    status: "ACTIVE",
    imageUrl: null,
    availableForSale: true,
    priceMin: "9.00",
    priceMax: "9.00",
    currencyCode: "USD",
    variants: [
      {
        variantGid: OFFER_VARIANT,
        title: "Default",
        price: "9.00",
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
    request: request("/api/post-purchase/offers", options),
  } as never) as Promise<Response>;
}

async function callChangeset(
  options: Parameters<typeof request>[1] = {},
): Promise<Response> {
  return changesetAction({
    request: request("/api/post-purchase/changeset", options),
  } as never) as Promise<Response>;
}

async function callEvents(
  options: Parameters<typeof request>[1] = {},
): Promise<Response> {
  return eventsAction({
    request: request("/api/post-purchase/events", options),
  } as never) as Promise<Response>;
}

beforeAll(async () => {
  process.env.POST_PURCHASE_ENABLED = "true";

  shop = await createShop("post-purchase-api");
  shops.push(shop.id);
  await prisma.shop.update({ where: { id: shop.id }, data: { isPlus: true } });
  await updateSettings(shop.id, { ...DEFAULT_SETTINGS, enabled: true });
  await upsertProductSnapshot(shop.id, snapshot());

  const rule = await createRule(shop.id, {
    name: "Post-purchase rule",
    status: "ACTIVE",
    priority: 10,
    matchMode: "ANY",
    heading: "Add to your order",
    triggers: [{ productGid: `gid://shopify/Product/${PURCHASED_PRODUCT}` }],
    offers: [{ productGid: OFFER_PRODUCT, variantGid: OFFER_VARIANT }],
    experiences: [
      {
        experience: "POST_PURCHASE",
        enabled: true,
        headline: "One more thing",
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
  delete process.env.POST_PURCHASE_ENABLED;
  await prisma.shop.deleteMany({ where: { id: { in: shops } } });
  await prisma.$disconnect();
});

describe("POST /api/post-purchase/offers", () => {
  it("returns offers built from the signed purchase", async () => {
    const response = await callOffers({
      token: tokenFor(shop.shopDomain),
      origin: "https://checkout.shopify.com",
      body: { referenceId: "ignored-by-the-route" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = await response.json();
    expect(body.enabled).toBe(true);
    expect(body.heading).toBe("Add to your order");
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]).toMatchObject({
      id: offerId,
      productGid: OFFER_PRODUCT,
      variantGid: OFFER_VARIANT,
      price: "9",
      quantity: 1,
      headline: "One more thing",
      ctaLabel: "Add to order",
    });
  });

  it("does not use purchase data from the request body", async () => {
    const response = await callOffers({
      token: tokenFor(shop.shopDomain),
      body: {
        lines: [{ productGid: "gid://shopify/Product/1", quantity: 1 }],
        orderTotal: 9999,
      },
    });

    const body = await response.json();
    expect(body.offers).toHaveLength(1);
  });

  it("returns no offers when the deployment flag is off", async () => {
    delete process.env.POST_PURCHASE_ENABLED;
    try {
      const response = await callOffers({ token: tokenFor(shop.shopDomain) });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.enabled).toBe(false);
      expect(body.offers).toHaveLength(0);
    } finally {
      process.env.POST_PURCHASE_ENABLED = "true";
    }
  });

  it("rejects a missing or tampered token", async () => {
    expect((await callOffers({})).status).toBe(401);

    const token = tokenFor(shop.shopDomain);
    const [header, payload] = token.split(".");
    const tampered = `${header}.${payload}.${base64url("forged")}`;
    expect((await callOffers({ token: tampered })).status).toBe(401);
  });

  it("answers the CORS preflight", async () => {
    const response = await callOffers({
      method: "OPTIONS",
      origin: "https://checkout.shopify.com",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects other methods and unknown shops", async () => {
    expect(
      (await callOffers({ method: "GET", token: tokenFor(shop.shopDomain) }))
        .status,
    ).toBe(405);

    const response = await callOffers({
      token: tokenFor("unknown-post-purchase.myshopify.com"),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("shop_not_found");
  });

  it("shows no offers to an uninstalled shop", async () => {
    const gone = await createShop("post-purchase-gone");
    shops.push(gone.id);
    await prisma.shop.update({
      where: { id: gone.id },
      data: { installationStatus: "UNINSTALLED" },
    });

    expect(
      (await callOffers({ token: tokenFor(gone.shopDomain) })).status,
    ).toBe(404);
  });
});

describe("POST /api/post-purchase/changeset", () => {
  it("signs the server-selected variant and quantity", async () => {
    const response = await callChangeset({
      token: tokenFor(shop.shopDomain),
      body: { offerId },
    });

    expect(response.status).toBe(200);
    const { token } = await response.json();
    expect(typeof token).toBe("string");

    const [encodedHeader, encodedPayload, signature] = token.split(".");
    const header = JSON.parse(
      Buffer.from(encodedHeader, "base64url").toString("utf8"),
    );
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );

    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({
      iss: "test-api-key",
      sub: "reference-1",
      changes: [{ type: "add_variant", variantID: 90201, quantity: 1 }],
    });

    const expected = createHmac("sha256", SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest("base64url");
    expect(signature).toBe(expected);
  });

  it("rejects an offer that belongs to another shop", async () => {
    const other = await createShop("post-purchase-other");
    shops.push(other.id);
    await upsertProductSnapshot(other.id, snapshot());
    const foreignRule = await createRule(other.id, {
      name: "Foreign post-purchase rule",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      triggers: [{ productGid: `gid://shopify/Product/${PURCHASED_PRODUCT}` }],
      offers: [{ productGid: OFFER_PRODUCT, variantGid: OFFER_VARIANT }],
      experiences: [
        {
          experience: "POST_PURCHASE",
          enabled: true,
          headline: null,
          body: null,
          ctaLabel: null,
        },
      ],
    });

    const response = await callChangeset({
      token: tokenFor(shop.shopDomain),
      body: { offerId: foreignRule.offers[0].id },
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("offer_not_available");
  });

  it("stops signing once the rule is paused", async () => {
    await prisma.recommendationRule.update({
      where: { id: ruleId },
      data: { status: "PAUSED" },
    });
    try {
      const response = await callChangeset({
        token: tokenFor(shop.shopDomain),
        body: { offerId },
      });

      expect(response.status).toBe(404);
    } finally {
      await prisma.recommendationRule.update({
        where: { id: ruleId },
        data: { status: "ACTIVE" },
      });
    }
  });

  it("refuses to sign while the deployment flag is off", async () => {
    delete process.env.POST_PURCHASE_ENABLED;
    try {
      const response = await callChangeset({
        token: tokenFor(shop.shopDomain),
        body: { offerId },
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("offers_disabled");
    } finally {
      process.env.POST_PURCHASE_ENABLED = "true";
    }
  });

  it("rejects a body without an offer id", async () => {
    const response = await callChangeset({
      token: tokenFor(shop.shopDomain),
      body: { changes: "nope" },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_body");
  });

  it("rejects an unsigned request", async () => {
    expect((await callChangeset({ body: { offerId } })).status).toBe(401);
  });
});

describe("POST /api/post-purchase/events", () => {
  it("forces the checkout surface and post-purchase experience", async () => {
    const response = await callEvents({
      token: tokenFor(shop.shopDomain),
      body: {
        events: [
          {
            eventType: "IMPRESSION",
            surface: "cart",
            experience: "PRE_PURCHASE",
            offerId,
            sessionKey: "post-purchase-session",
            dedupeKey: "post-purchase-forced",
          },
        ],
      },
    });

    expect(response.status).toBe(204);

    const row = await prisma.analyticsEvent.findUnique({
      where: { dedupeKey: `${shop.id}:post-purchase-forced` },
    });
    expect(row).toMatchObject({
      shopId: shop.id,
      ruleId,
      eventType: "IMPRESSION",
      surface: "CHECKOUT",
      experience: "POST_PURCHASE",
    });
  });

  it("drops an offer id that belongs to another shop", async () => {
    const other = await createShop("post-purchase-events-other");
    shops.push(other.id);
    await upsertProductSnapshot(other.id, snapshot());
    const foreignRule = await createRule(other.id, {
      name: "Foreign events rule",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      triggers: [{ productGid: `gid://shopify/Product/${PURCHASED_PRODUCT}` }],
      offers: [{ productGid: OFFER_PRODUCT, variantGid: OFFER_VARIANT }],
    });

    const response = await callEvents({
      token: tokenFor(shop.shopDomain),
      body: {
        events: [
          {
            eventType: "OFFER_ACCEPTED",
            surface: "checkout",
            experience: "POST_PURCHASE",
            offerId: foreignRule.offers[0].id,
            sessionKey: "post-purchase-session",
            dedupeKey: "post-purchase-foreign",
          },
        ],
      },
    });

    expect(response.status).toBe(204);
    expect(
      await prisma.analyticsEvent.findUnique({
        where: { dedupeKey: `${shop.id}:post-purchase-foreign` },
      }),
    ).toBeNull();
  });

  it("rejects a batch with no valid events", async () => {
    const response = await callEvents({
      token: tokenFor(shop.shopDomain),
      body: { events: [{ eventType: "NOPE", offerId: randomUUID() }] },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("no_valid_events");
  });
});
