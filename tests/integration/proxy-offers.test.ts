import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import { loader } from "../../app/routes/proxy.offers";
import { upsertProductSnapshot } from "../../app/services/catalog.server";
import type { CatalogProduct } from "../../app/services/catalog.server";
import { createRule } from "../../app/services/rules.server";
import { DEFAULT_SETTINGS, updateSettings } from "../../app/services/settings.server";
import { computeAppProxySignature } from "../../app/utils/app-proxy.server";
import { createShop, prisma } from "../helpers/db";

const SECRET = "integration-proxy-secret";
const TRIGGER = "gid://shopify/Product/601";
const OFFER = "gid://shopify/Product/602";
const OFFER_VARIANT = "gid://shopify/ProductVariant/60201";
const CART = JSON.stringify([{ productGid: TRIGGER, variantGid: null, quantity: 1 }]);

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

/** Signs the query string the way Shopify does before proxying the request. */
function signedRequest(
  shop: string | null,
  params: Record<string, string>,
): Request {
  const search = new URLSearchParams(params);
  if (shop) search.set("shop", shop);
  search.set("path_prefix", "/apps/upsell");
  search.set("timestamp", "1760000000");
  search.set("signature", computeAppProxySignature(search, SECRET));
  return new Request(`https://shop.example/apps/upsell/offers?${search}`);
}

async function callLoader(request: Request) {
  const response = (await loader({ request } as never)) as Response;
  return { status: response.status, body: await response.json() };
}

describe("app proxy offers endpoint", () => {
  let shopA: Awaited<ReturnType<typeof createShop>>;
  let shopB: Awaited<ReturnType<typeof createShop>>;

  beforeAll(async () => {
    process.env.SHOPIFY_API_SECRET = SECRET;
    shopA = await createShop("proxy-a");
    shopB = await createShop("proxy-b");

    await upsertProductSnapshot(shopA.id, snapshot());
    await createRule(shopA.id, {
      name: "Internal rule name",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      heading: "Pairs with your purchase",
      showOnProductPage: true,
      showOnCartPage: false,
      triggers: [{ productGid: TRIGGER, variantGid: null }],
      offers: [{ productGid: OFFER, variantGid: OFFER_VARIANT }],
    });
    await updateSettings(shopA.id, { ...DEFAULT_SETTINGS, enabled: true });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { in: [shopA.id, shopB.id] } } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("returns public offers for a correctly signed request", async () => {
    const { status, body } = await callLoader(
      signedRequest(shopA.shopDomain, { surface: "product", cart: CART }),
    );

    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.heading).toBe("Pairs with your purchase");
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]).toMatchObject({
      variantGid: OFFER_VARIANT,
      productTitle: "Cleaning spray",
      price: "12.00",
      currencyCode: "USD",
    });
    expect(body.offers[0]).not.toHaveProperty("ruleName");
  });

  it("rejects a tampered signature", async () => {
    const url = signedRequest(shopA.shopDomain, { surface: "product", cart: CART });
    const tampered = new URL(url.url);
    tampered.searchParams.set("surface", "cart");

    const { status, body } = await callLoader(new Request(tampered));
    expect(status).toBe(401);
    expect(body.error).toBe("invalid_signature");
  });

  it("rejects an unsigned request", async () => {
    const request = new Request(
      `https://shop.example/apps/upsell/offers?shop=${shopA.shopDomain}&surface=product`,
    );

    const { status } = await callLoader(request);
    expect(status).toBe(401);
  });

  it("requires the signed shop parameter", async () => {
    const { status, body } = await callLoader(
      signedRequest(null, { surface: "product", cart: CART }),
    );

    expect(status).toBe(400);
    expect(body.error).toBe("missing_shop");
  });

  it("does not serve an unknown shop", async () => {
    const { status, body } = await callLoader(
      signedRequest("unknown-shop.myshopify.com", { surface: "product", cart: CART }),
    );

    expect(status).toBe(404);
    expect(body.error).toBe("shop_not_found");
  });

  it("does not serve an uninstalled shop", async () => {
    const shopC = await createShop("proxy-uninstalled");
    await prisma.shop.update({
      where: { id: shopC.id },
      data: { installationStatus: "UNINSTALLED" },
    });
    await updateSettings(shopC.id, { ...DEFAULT_SETTINGS, enabled: true });

    const { status, body } = await callLoader(
      signedRequest(shopC.shopDomain, { surface: "product", cart: CART }),
    );
    expect(status).toBe(404);

    await prisma.shop.delete({ where: { id: shopC.id } });
    expect(body.error).toBe("shop_not_found");
  });

  it("rejects an unknown surface", async () => {
    const { status, body } = await callLoader(
      signedRequest(shopA.shopDomain, { surface: "checkout", cart: CART }),
    );

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_surface");
  });

  it("reports a disabled shop instead of offers", async () => {
    const { status, body } = await callLoader(
      signedRequest(shopB.shopDomain, { surface: "product", cart: CART }),
    );

    expect(status).toBe(200);
    expect(body).toEqual({ enabled: false, heading: null, offers: [] });
  });

  it("returns no offers when the request targets a disabled surface", async () => {
    const { status, body } = await callLoader(
      signedRequest(shopA.shopDomain, { surface: "cart", cart: CART }),
    );

    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.offers).toEqual([]);
  });

  it("returns 503 when the app secret is missing", async () => {
    const previous = process.env.SHOPIFY_API_SECRET;
    delete process.env.SHOPIFY_API_SECRET;

    const { status, body } = await callLoader(
      signedRequest(shopA.shopDomain, { surface: "product", cart: CART }),
    );

    process.env.SHOPIFY_API_SECRET = previous;
    expect(status).toBe(503);
    expect(body.error).toBe("not_configured");
  });

  it("throttles a shop that floods the endpoint", async () => {
    const floodShop = await createShop("proxy-flood");

    for (let i = 0; i < 120; i += 1) {
      const { status } = await callLoader(
        signedRequest(floodShop.shopDomain, { surface: "product", cart: CART }),
      );
      expect(status).toBe(200);
    }

    const request = signedRequest(floodShop.shopDomain, {
      surface: "product",
      cart: CART,
    });
    const response = (await loader({ request } as never)) as Response;

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();

    await prisma.shop.deleteMany({ where: { id: floodShop.id } });
  });
});
