import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import { action } from "../../app/routes/proxy.events";
import { createRule } from "../../app/services/rules.server";
import { computeAppProxySignature } from "../../app/utils/app-proxy.server";
import { createShop, prisma } from "../helpers/db";

const SECRET = "integration-events-secret";
const SESSION = "proxy-events-session-01";

function signedRequest(
  shop: string,
  init: { method?: string; body?: string } = {},
): Request {
  const search = new URLSearchParams({
    shop,
    path_prefix: "/apps/upsell",
    timestamp: "1760000000",
  });
  search.set("signature", computeAppProxySignature(search, SECRET));
  return new Request(`https://shop.example/apps/upsell/events?${search}`, {
    method: init.method ?? "POST",
    body: init.body,
  });
}

async function callAction(request: Request) {
  const response = (await action({ request, params: {}, context: {} } as never)) as Response;
  return { status: response.status };
}

describe("app proxy events endpoint", () => {
  let shop: Awaited<ReturnType<typeof createShop>>;
  let offerId: string;

  beforeAll(async () => {
    process.env.SHOPIFY_API_SECRET = SECRET;
    shop = await createShop("proxy-events");

    const rule = await createRule(shop.id, {
      name: "Events rule",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      triggers: [{ productGid: "gid://shopify/Product/701" }],
      offers: [
        {
          productGid: "gid://shopify/Product/702",
          variantGid: "gid://shopify/ProductVariant/70201",
        },
      ],
    });
    offerId = rule.offers[0]!.id;
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: shop.id } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("stores a signed event and returns no content", async () => {
    const body = JSON.stringify({
      eventType: "IMPRESSION",
      surface: "product",
      offerId,
      sessionKey: SESSION,
      dedupeKey: `${SESSION}:IMPRESSION:gid://shopify/ProductVariant/70201`,
    });

    const { status } = await callAction(signedRequest(shop.shopDomain, { body }));
    expect(status).toBe(204);

    const stored = await prisma.analyticsEvent.findFirstOrThrow({
      where: { shopId: shop.id },
    });
    expect(stored.eventType).toBe("IMPRESSION");
    expect(stored.surface).toBe("PRODUCT_PAGE");
    expect(stored.offerVariantGid).toBe("gid://shopify/ProductVariant/70201");
  });

  it("does not duplicate a repeated impression", async () => {
    const body = JSON.stringify({
      eventType: "IMPRESSION",
      surface: "product",
      offerId,
      sessionKey: SESSION,
      dedupeKey: `${SESSION}:IMPRESSION:gid://shopify/ProductVariant/70201`,
    });

    expect((await callAction(signedRequest(shop.shopDomain, { body }))).status).toBe(204);
    expect(
      await prisma.analyticsEvent.count({
        where: { shopId: shop.id, eventType: "IMPRESSION" },
      }),
    ).toBe(1);
  });

  it("rejects an unsigned request", async () => {
    const request = new Request(
      `https://shop.example/apps/upsell/events?shop=${shop.shopDomain}`,
      { method: "POST", body: "{}" },
    );

    expect((await callAction(request)).status).toBe(401);
  });

  it("rejects a non-JSON body", async () => {
    const { status } = await callAction(
      signedRequest(shop.shopDomain, { body: "not json" }),
    );
    expect(status).toBe(400);
  });

  it("rejects a body with no valid events", async () => {
    const body = JSON.stringify({ eventType: "ORDER_ATTRIBUTED", offerId });
    const { status } = await callAction(signedRequest(shop.shopDomain, { body }));
    expect(status).toBe(400);
  });

  it("acknowledges but drops events for unknown offers", async () => {
    const body = JSON.stringify({
      eventType: "ADD_SUCCESS",
      surface: "cart",
      offerId: "cm3xk9q2b0000unknown000000",
      sessionKey: SESSION,
      dedupeKey: `${SESSION}:ADD_SUCCESS:unknown`,
    });

    expect((await callAction(signedRequest(shop.shopDomain, { body }))).status).toBe(204);
    expect(
      await prisma.analyticsEvent.count({
        where: { shopId: shop.id, eventType: "ADD_SUCCESS" },
      }),
    ).toBe(0);
  });

  it("rejects a GET request", async () => {
    const { status } = await callAction(
      signedRequest(shop.shopDomain, { method: "GET" }),
    );
    expect(status).toBe(405);
  });

  it("does not serve an uninstalled shop", async () => {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { installationStatus: "UNINSTALLED" },
    });

    const body = JSON.stringify({
      eventType: "IMPRESSION",
      surface: "product",
      offerId,
      sessionKey: SESSION,
      dedupeKey: `${SESSION}:IMPRESSION:uninstalled`,
    });
    const { status } = await callAction(signedRequest(shop.shopDomain, { body }));

    await prisma.shop.update({
      where: { id: shop.id },
      data: { installationStatus: "INSTALLED" },
    });
    expect(status).toBe(404);
  });

  it("throttles a shop that floods the endpoint", async () => {
    const floodShop = await createShop("proxy-events-flood");

    for (let i = 0; i < 60; i += 1) {
      const { status } = await callAction(
        signedRequest(floodShop.shopDomain, { body: "{}" }),
      );
      expect(status).toBe(400);
    }

    const request = signedRequest(floodShop.shopDomain, { body: "{}" });
    const response = (await action({
      request,
      params: {},
      context: {},
    } as never)) as Response;

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();

    await prisma.shop.deleteMany({ where: { id: floodShop.id } });
  });
});
