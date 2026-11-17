import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import { loader } from "../../app/routes/proxy.offers";
import { upsertProductSnapshot } from "../../app/services/catalog.server";
import type { CatalogProduct } from "../../app/services/catalog.server";
import { createRule, setRuleStatus } from "../../app/services/rules.server";
import { DEFAULT_SETTINGS, updateSettings } from "../../app/services/settings.server";
import { computeAppProxySignature } from "../../app/utils/app-proxy.server";
import { createShop, prisma } from "../helpers/db";

const SECRET = "integration-proxy-secret";

const TRIGGER_PRODUCT = "gid://shopify/Product/701";
const TRIGGER_VARIANT = "gid://shopify/ProductVariant/70101";
const OFFER_PRODUCT = "gid://shopify/Product/702";
const OFFER_VARIANT = "gid://shopify/ProductVariant/70201";
const MANUAL_OFFER_PRODUCT = "gid://shopify/Product/703";
const MANUAL_OFFER_VARIANT = "gid://shopify/ProductVariant/70301";
const CONDITION_OFFER_PRODUCT = "gid://shopify/Product/704";
const CONDITION_OFFER_VARIANT = "gid://shopify/ProductVariant/70401";
const CART_A = "gid://shopify/Product/705";
const CART_A_VARIANT = "gid://shopify/ProductVariant/70501";
const CART_B = "gid://shopify/Product/706";
const CART_B_VARIANT = "gid://shopify/ProductVariant/70601";
const CART_C = "gid://shopify/Product/707";
const CART_C_VARIANT = "gid://shopify/ProductVariant/70701";

function snapshot(productGid: string, variantGid: string, title: string): CatalogProduct {
  return {
    productGid,
    title,
    handle: title.toLowerCase().replace(/\s+/g, "-"),
    status: "ACTIVE",
    imageUrl: null,
    availableForSale: true,
    priceMin: "12.00",
    priceMax: "12.00",
    currencyCode: "USD",
    variants: [
      {
        variantGid,
        title: "Default",
        price: "12.00",
        compareAtPrice: null,
        availableForSale: true,
        position: 0,
      },
    ],
  };
}

type Line = { productGid: string; variantGid: string | null; quantity: number };

function cart(...lines: Line[]): string {
  return JSON.stringify(lines);
}

const EMPTY_CART = "[]";
const TRIGGER_IN_CART = cart({
  productGid: TRIGGER_PRODUCT,
  variantGid: TRIGGER_VARIANT,
  quantity: 1,
});

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

type Body = {
  enabled: boolean;
  heading: string | null;
  offers: Array<{ productGid: string; variantGid: string; productTitle: string }>;
  error?: string;
};

describe("app proxy offers endpoint", () => {
  let shopA: Awaited<ReturnType<typeof createShop>>;
  let shopB: Awaited<ReturnType<typeof createShop>>;
  let shopManual: Awaited<ReturnType<typeof createShop>>;
  let shopConditions: Awaited<ReturnType<typeof createShop>>;
  let triggerRuleId: string;

  beforeAll(async () => {
    process.env.SHOPIFY_API_SECRET = SECRET;
    shopA = await createShop("proxy-a");
    shopB = await createShop("proxy-b");
    shopManual = await createShop("proxy-manual");
    shopConditions = await createShop("proxy-conditions");

    for (const shop of [shopA, shopConditions]) {
      await upsertProductSnapshot(
        shop.id,
        snapshot(OFFER_PRODUCT, OFFER_VARIANT, "Cleaning spray"),
      );
    }
    await upsertProductSnapshot(
      shopManual.id,
      snapshot(MANUAL_OFFER_PRODUCT, MANUAL_OFFER_VARIANT, "Microfibre cloth"),
    );
    await upsertProductSnapshot(
      shopConditions.id,
      snapshot(CONDITION_OFFER_PRODUCT, CONDITION_OFFER_VARIANT, "Spray bottle"),
    );

    // Deliberately no settings row for shopA: storefront delivery must not
    // depend on the merchant turning checkout offers on first.
    const triggerRule = await createRule(shopA.id, {
      name: "Trigger offer",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      heading: "Pairs with your purchase",
      showOnProductPage: true,
      showOnCartPage: false,
      triggers: [{ productGid: TRIGGER_PRODUCT, variantGid: TRIGGER_VARIANT }],
      offers: [{ productGid: OFFER_PRODUCT, variantGid: OFFER_VARIANT }],
    });
    triggerRuleId = triggerRule.id;

    // Manual offer: no trigger products, sells to any non-empty cart.
    await createRule(shopManual.id, {
      name: "Any cart offer",
      status: "ACTIVE",
      priority: 10,
      heading: "Add a cloth",
      sources: ["MANUAL"],
      showOnProductPage: false,
      showOnCartPage: true,
      triggers: [],
      offers: [
        { productGid: MANUAL_OFFER_PRODUCT, variantGid: MANUAL_OFFER_VARIANT },
      ],
    });

    await createRule(shopConditions.id, {
      name: "Big cart offer",
      status: "ACTIVE",
      priority: 10,
      heading: "Stock up",
      sources: ["MANUAL"],
      showOnCartPage: true,
      triggers: [],
      offers: [
        { productGid: CONDITION_OFFER_PRODUCT, variantGid: CONDITION_OFFER_VARIANT },
      ],
      conditions: [
        {
          joinOp: "AND",
          conditions: [
            { field: "CART_SUBTOTAL", operator: "GTE", valueJson: 50 },
            { field: "CART_TOTAL_QUANTITY", operator: "GT", valueJson: 1 },
          ],
        },
      ],
    });
  });

  afterAll(async () => {
    const ids = [shopA?.id, shopB?.id, shopManual?.id, shopConditions?.id].filter(
      (id): id is string => Boolean(id),
    );
    await prisma.shop.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  describe("authentication", () => {
    it("rejects a tampered signature", async () => {
      const url = signedRequest(shopA.shopDomain, {
        surface: "product",
        cart: EMPTY_CART,
      });
      const tampered = new URL(url.url);
      tampered.searchParams.set("surface", "cart");

      const { status, body } = await callLoader(new Request(tampered));
      expect(status).toBe(401);
      expect((body as Body).error).toBe("invalid_signature");
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
        signedRequest(null, { surface: "product", cart: EMPTY_CART }),
      );

      expect(status).toBe(400);
      expect((body as Body).error).toBe("missing_shop");
    });

    it("does not serve an unknown shop", async () => {
      const { status, body } = await callLoader(
        signedRequest("unknown-shop.myshopify.com", { surface: "product" }),
      );

      expect(status).toBe(404);
      expect((body as Body).error).toBe("shop_not_found");
    });

    it("does not serve an uninstalled shop", async () => {
      const shopC = await createShop("proxy-uninstalled");
      await prisma.shop.update({
        where: { id: shopC.id },
        data: { installationStatus: "UNINSTALLED" },
      });

      const { status, body } = await callLoader(
        signedRequest(shopC.shopDomain, { surface: "product" }),
      );
      expect(status).toBe(404);

      await prisma.shop.delete({ where: { id: shopC.id } });
      expect((body as Body).error).toBe("shop_not_found");
    });

    it("rejects an unknown surface", async () => {
      const { status, body } = await callLoader(
        signedRequest(shopA.shopDomain, { surface: "checkout" }),
      );

      expect(status).toBe(400);
      expect((body as Body).error).toBe("invalid_surface");
    });

    it("returns 503 when the app secret is missing", async () => {
      const previous = process.env.SHOPIFY_API_SECRET;
      delete process.env.SHOPIFY_API_SECRET;

      const { status, body } = await callLoader(
        signedRequest(shopA.shopDomain, { surface: "product" }),
      );

      process.env.SHOPIFY_API_SECRET = previous;
      expect(status).toBe(503);
      expect((body as Body).error).toBe("not_configured");
    });

    it("throttles a shop that floods the endpoint", async () => {
      const floodShop = await createShop("proxy-flood");

      for (let i = 0; i < 600; i += 1) {
        const { status } = await callLoader(
          signedRequest(floodShop.shopDomain, {
            surface: "product",
            cart: EMPTY_CART,
          }),
        );
        expect(status).toBe(200);
      }

      const request = signedRequest(floodShop.shopDomain, {
        surface: "product",
        cart: EMPTY_CART,
      });
      const response = (await loader({ request } as never)) as Response;

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBeTruthy();

      await prisma.shop.deleteMany({ where: { id: floodShop.id } });
    });
  });

  describe("storefront delivery", () => {
    it("shows a triggered offer on the product page without any cart line", async () => {
      const { status, body } = await callLoader(
        signedRequest(shopA.shopDomain, {
          surface: "product",
          cart: EMPTY_CART,
          product: TRIGGER_PRODUCT,
          variant: TRIGGER_VARIANT,
        }),
      );

      expect(status).toBe(200);
      const payload = body as Body;
      expect(payload.enabled).toBe(true);
      expect(payload.heading).toBe("Pairs with your purchase");
      expect(payload.offers).toHaveLength(1);
      expect(payload.offers[0]).toMatchObject({
        productGid: OFFER_PRODUCT,
        variantGid: OFFER_VARIANT,
        productTitle: "Cleaning spray",
      });
    });

    it("shows the offer on the product page when the trigger is already in cart", async () => {
      const { body } = await callLoader(
        signedRequest(shopA.shopDomain, {
          surface: "product",
          cart: TRIGGER_IN_CART,
          product: TRIGGER_PRODUCT,
          variant: TRIGGER_VARIANT,
        }),
      );

      expect((body as Body).offers).toHaveLength(1);
    });

    it("honours the placements declared on the offer", async () => {
      const { body } = await callLoader(
        signedRequest(shopA.shopDomain, {
          surface: "cart",
          cart: TRIGGER_IN_CART,
        }),
      );

      expect((body as Body).enabled).toBe(true);
      expect((body as Body).offers).toEqual([]);
    });

    it("never offers a product that is already in the cart", async () => {
      const withOffer = await callLoader(
        signedRequest(shopA.shopDomain, {
          surface: "product",
          cart: cart(
            {
              productGid: TRIGGER_PRODUCT,
              variantGid: TRIGGER_VARIANT,
              quantity: 1,
            },
            {
              productGid: OFFER_PRODUCT,
              variantGid: OFFER_VARIANT,
              quantity: 1,
            },
          ),
          product: TRIGGER_PRODUCT,
          variant: TRIGGER_VARIANT,
        }),
      );
      expect((withOffer.body as Body).offers).toEqual([]);
    });

    it("returns nothing while the rule is paused and offers again when active", async () => {
      await setRuleStatus(shopA.id, triggerRuleId, "PAUSED");
      const paused = await callLoader(
        signedRequest(shopA.shopDomain, {
          surface: "product",
          cart: EMPTY_CART,
          product: TRIGGER_PRODUCT,
          variant: TRIGGER_VARIANT,
        }),
      );
      expect((paused.body as Body).offers).toEqual([]);

      await setRuleStatus(shopA.id, triggerRuleId, "ACTIVE");
      const active = await callLoader(
        signedRequest(shopA.shopDomain, {
          surface: "product",
          cart: EMPTY_CART,
          product: TRIGGER_PRODUCT,
          variant: TRIGGER_VARIANT,
        }),
      );
      expect((active.body as Body).offers).toHaveLength(1);
    });

    it("serves no offers once the merchant turns the placement off", async () => {
      await updateSettings(shopA.id, {
        ...DEFAULT_SETTINGS,
        productPageEnabled: false,
      });
      const { body } = await callLoader(
        signedRequest(shopA.shopDomain, {
          surface: "product",
          cart: EMPTY_CART,
          product: TRIGGER_PRODUCT,
          variant: TRIGGER_VARIANT,
        }),
      );
      expect((body as Body).enabled).toBe(false);
      expect((body as Body).offers).toEqual([]);

      await updateSettings(shopA.id, {
        ...DEFAULT_SETTINGS,
        productPageEnabled: true,
      });
    });
  });

  describe("manual offers", () => {
    it("stays hidden while the cart is empty", async () => {
      const { body } = await callLoader(
        signedRequest(shopManual.shopDomain, { surface: "cart", cart: EMPTY_CART }),
      );

      expect((body as Body).offers).toEqual([]);
    });

    it("follows add and remove through the eight-step cart sequence", async () => {
      const steps: Array<{ label: string; cart: string; expectOffer: boolean }> = [
        { label: "cart empty", cart: EMPTY_CART, expectOffer: false },
        {
          label: "add A",
          cart: cart({ productGid: CART_A, variantGid: CART_A_VARIANT, quantity: 1 }),
          expectOffer: true,
        },
        { label: "remove A", cart: EMPTY_CART, expectOffer: false },
        {
          label: "add B",
          cart: cart({ productGid: CART_B, variantGid: CART_B_VARIANT, quantity: 1 }),
          expectOffer: true,
        },
        {
          label: "add C",
          cart: cart(
            { productGid: CART_B, variantGid: CART_B_VARIANT, quantity: 1 },
            { productGid: CART_C, variantGid: CART_C_VARIANT, quantity: 1 },
          ),
          expectOffer: true,
        },
        {
          label: "remove B",
          cart: cart({ productGid: CART_C, variantGid: CART_C_VARIANT, quantity: 1 }),
          expectOffer: true,
        },
        { label: "remove C", cart: EMPTY_CART, expectOffer: false },
        {
          label: "add A again",
          cart: cart({ productGid: CART_A, variantGid: CART_A_VARIANT, quantity: 1 }),
          expectOffer: true,
        },
      ];

      for (const step of steps) {
        const { status, body } = await callLoader(
          signedRequest(shopManual.shopDomain, { surface: "cart", cart: step.cart }),
        );
        expect(status, step.label).toBe(200);
        const offers = (body as Body).offers;
        expect(offers.length, step.label).toBe(step.expectOffer ? 1 : 0);
        if (step.expectOffer) {
          expect(offers[0].productGid).toBe(MANUAL_OFFER_PRODUCT);
        }
      }
    });
  });

  describe("condition evaluation", () => {
    it("requires both the subtotal and the quantity condition (AND)", async () => {
      const onlySubtotal = await callLoader(
        signedRequest(shopConditions.shopDomain, {
          surface: "cart",
          cart: cart({ productGid: CART_A, variantGid: CART_A_VARIANT, quantity: 1 }),
          subtotal: "100.00",
        }),
      );
      expect((onlySubtotal.body as Body).offers).toEqual([]);

      const onlyQuantity = await callLoader(
        signedRequest(shopConditions.shopDomain, {
          surface: "cart",
          cart: cart({ productGid: CART_A, variantGid: CART_A_VARIANT, quantity: 2 }),
          subtotal: "10.00",
        }),
      );
      expect((onlyQuantity.body as Body).offers).toEqual([]);

      const both = await callLoader(
        signedRequest(shopConditions.shopDomain, {
          surface: "cart",
          cart: cart({ productGid: CART_A, variantGid: CART_A_VARIANT, quantity: 2 }),
          subtotal: "100.00",
        }),
      );
      expect((both.body as Body).offers).toHaveLength(1);
      expect((both.body as Body).offers[0].productGid).toBe(
        CONDITION_OFFER_PRODUCT,
      );
    });

    it("fails closed when the subtotal is unknown", async () => {
      const { body } = await callLoader(
        signedRequest(shopConditions.shopDomain, {
          surface: "cart",
          cart: cart({ productGid: CART_A, variantGid: CART_A_VARIANT, quantity: 2 }),
        }),
      );
      expect((body as Body).offers).toEqual([]);
    });
  });

  describe("tenant isolation", () => {
    it("never serves another shop's offers", async () => {
      const { status, body } = await callLoader(
        signedRequest(shopB.shopDomain, {
          surface: "product",
          cart: TRIGGER_IN_CART,
        }),
      );

      expect(status).toBe(200);
      expect((body as Body).enabled).toBe(true);
      expect((body as Body).offers).toEqual([]);
    });
  });
});
