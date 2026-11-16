import { afterAll, describe, expect, it } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../../app/db.server";
import {
  deleteProductSnapshot,
  fetchProduct,
  normalizeProduct,
  searchProducts,
  syncProductByGid,
  upsertProductSnapshot,
} from "../../app/services/catalog.server";
import type { CatalogProduct } from "../../app/services/catalog.server";
import {
  deleteProductFromWebhook,
  productGidFromWebhookPayload,
} from "../../app/services/product-sync.server";
import { createShop, prisma } from "../helpers/db";

const PRODUCT_GID = "gid://shopify/Product/900";
const VARIANT_A = "gid://shopify/ProductVariant/9001";
const VARIANT_B = "gid://shopify/ProductVariant/9002";

type Captured = { query?: string; variables?: Record<string, unknown> };

function fakeAdmin(payload: unknown, captured: Captured = {}) {
  const admin = {
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      captured.query = String(query);
      captured.variables = options?.variables;
      return { json: async () => payload } as Response;
    },
  };
  return admin as unknown as AdminApiContext;
}

function productNode(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_GID,
    title: "Trail Runner",
    handle: "trail-runner",
    status: "ACTIVE",
    featuredImage: { url: "https://cdn.example.com/trail.png" },
    priceRangeV2: {
      minVariantPrice: { amount: "89.00", currencyCode: "USD" },
      maxVariantPrice: { amount: "99.00", currencyCode: "USD" },
    },
    variants: {
      edges: [
        {
          node: {
            id: VARIANT_A,
            title: "Size 9",
            price: "89.00",
            compareAtPrice: null,
            availableForSale: false,
          },
        },
        {
          node: {
            id: VARIANT_B,
            title: "Size 10",
            price: "99.00",
            compareAtPrice: "120.00",
            availableForSale: true,
          },
        },
      ],
    },
    ...overrides,
  };
}

function catalogProduct(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    productGid: PRODUCT_GID,
    title: "Trail Runner",
    handle: "trail-runner",
    status: "ACTIVE",
    imageUrl: "https://cdn.example.com/trail.png",
    availableForSale: true,
    priceMin: "89.00",
    priceMax: "99.00",
    currencyCode: "USD",
    variants: [
      {
        variantGid: VARIANT_A,
        title: "Size 9",
        price: "89.00",
        compareAtPrice: null,
        availableForSale: false,
        position: 0,
      },
      {
        variantGid: VARIANT_B,
        title: "Size 10",
        price: "99.00",
        compareAtPrice: "120.00",
        availableForSale: true,
        position: 1,
      },
    ],
    ...overrides,
  };
}

describe("catalog normalization", () => {
  it("maps product fields and keeps variant order", () => {
    const product = normalizeProduct(productNode() as never);

    expect(product.productGid).toBe(PRODUCT_GID);
    expect(product.imageUrl).toBe("https://cdn.example.com/trail.png");
    expect(product.priceMin).toBe("89.00");
    expect(product.priceMax).toBe("99.00");
    expect(product.currencyCode).toBe("USD");
    expect(product.variants.map((variant) => variant.position)).toEqual([0, 1]);
    expect(product.variants[1].compareAtPrice).toBe("120.00");
  });

  it("treats a product as available when any variant is available", () => {
    const product = normalizeProduct(productNode() as never);
    expect(product.variants[0].availableForSale).toBe(false);
    expect(product.availableForSale).toBe(true);
  });

  it("marks a product unavailable when no variant is available", () => {
    const node = productNode();
    const edges = node.variants.edges.map((edge) => ({
      node: { ...edge.node, availableForSale: false },
    }));

    expect(
      normalizeProduct({ ...node, variants: { edges } } as never).availableForSale,
    ).toBe(false);
  });

  it("survives a product with no image and no price range", () => {
    const node = productNode({ featuredImage: null, priceRangeV2: null });
    const product = normalizeProduct(node as never);

    expect(product.imageUrl).toBeNull();
    expect(product.priceMin).toBeNull();
    expect(product.priceMax).toBeNull();
    expect(product.currencyCode).toBeNull();
  });
});

describe("catalog queries", () => {
  it("clamps the page size and forwards cursor and query", async () => {
    const captured: Captured = {};
    const admin = fakeAdmin(
      {
        data: {
          products: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            edges: [{ node: productNode() }],
          },
        },
      },
      captured,
    );

    const page = await searchProducts(admin, { query: "trail", after: "prev", first: 500 });

    expect(captured.variables).toMatchObject({ first: 50, after: "prev", query: "trail" });
    expect(page.products).toHaveLength(1);
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("cursor-1");
  });

  it("throws instead of returning an empty page when Shopify reports GraphQL errors", async () => {
    const admin = fakeAdmin({ errors: [{ message: "Access denied" }] });

    await expect(searchProducts(admin, { first: 10 })).rejects.toThrow(/Access denied/);
  });

  it("returns null when the product is missing", async () => {
    const admin = fakeAdmin({ data: { product: null } });
    await expect(fetchProduct(admin, PRODUCT_GID)).resolves.toBeNull();
  });
});

describe("product snapshots", () => {
  const shopIds: string[] = [];

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("upserts idempotently and replaces variants", async () => {
    const shop = await createShop("catalog");
    shopIds.push(shop.id);

    await upsertProductSnapshot(shop.id, catalogProduct());
    await upsertProductSnapshot(
      shop.id,
      catalogProduct({
        title: "Trail Runner v2",
        variants: [catalogProduct().variants[1]],
      }),
    );

    const snapshots = await db.productSnapshot.findMany({ where: { shopId: shop.id } });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].title).toBe("Trail Runner v2");

    const variants = await db.productVariantSnapshot.findMany({
      where: { shopId: shop.id },
      orderBy: { position: "asc" },
    });
    expect(variants).toHaveLength(1);
    expect(variants[0].variantGid).toBe(VARIANT_B);
  });

  it("keeps the same product separate for two shops", async () => {
    const shopA = await createShop("catalog-a");
    const shopB = await createShop("catalog-b");
    shopIds.push(shopA.id, shopB.id);

    await upsertProductSnapshot(shopA.id, catalogProduct({ title: "Shop A title" }));
    await upsertProductSnapshot(shopB.id, catalogProduct({ title: "Shop B title" }));

    const a = await db.productSnapshot.findFirst({ where: { shopId: shopA.id } });
    const b = await db.productSnapshot.findFirst({ where: { shopId: shopB.id } });

    expect(a?.title).toBe("Shop A title");
    expect(b?.title).toBe("Shop B title");
  });

  it("scopes deletion to the owning shop", async () => {
    const shopA = await createShop("catalog-del-a");
    const shopB = await createShop("catalog-del-b");
    shopIds.push(shopA.id, shopB.id);

    await upsertProductSnapshot(shopA.id, catalogProduct());
    await upsertProductSnapshot(shopB.id, catalogProduct());

    await deleteProductSnapshot(shopA.id, PRODUCT_GID);

    await expect(
      db.productSnapshot.count({ where: { shopId: shopA.id } }),
    ).resolves.toBe(0);
    await expect(
      db.productSnapshot.count({ where: { shopId: shopB.id } }),
    ).resolves.toBe(1);
  });

  it("drops the snapshot when the product no longer exists in Shopify", async () => {
    const shop = await createShop("catalog-gone");
    shopIds.push(shop.id);
    await upsertProductSnapshot(shop.id, catalogProduct());

    const admin = fakeAdmin({ data: { product: null } });
    await expect(syncProductByGid(admin, shop.id, PRODUCT_GID)).resolves.toBeNull();

    await expect(
      db.productSnapshot.count({ where: { shopId: shop.id } }),
    ).resolves.toBe(0);
  });

  it("writes a fresh snapshot from the live product query", async () => {
    const shop = await createShop("catalog-sync");
    shopIds.push(shop.id);

    const admin = fakeAdmin({ data: { product: productNode({ title: "Live title" }) } });
    const synced = await syncProductByGid(admin, shop.id, PRODUCT_GID);

    expect(synced?.title).toBe("Live title");
    const snapshot = await db.productSnapshot.findFirst({ where: { shopId: shop.id } });
    expect(snapshot?.title).toBe("Live title");
    await expect(
      db.productVariantSnapshot.count({ where: { shopId: shop.id } }),
    ).resolves.toBe(2);
  });
});

describe("product webhooks", () => {
  const shopIds: string[] = [];

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("removes the snapshot when an installed shop deletes a product", async () => {
    const shop = await createShop("webhook-delete");
    shopIds.push(shop.id);
    await upsertProductSnapshot(shop.id, catalogProduct());

    await deleteProductFromWebhook(shop.shopDomain, PRODUCT_GID);

    await expect(
      db.productSnapshot.count({ where: { shopId: shop.id } }),
    ).resolves.toBe(0);
  });

  it("ignores product webhooks for an uninstalled shop", async () => {
    const shop = await createShop("webhook-uninstalled");
    shopIds.push(shop.id);
    await upsertProductSnapshot(shop.id, catalogProduct());
    await prisma.shop.update({
      where: { id: shop.id },
      data: { installationStatus: "UNINSTALLED" },
    });

    await deleteProductFromWebhook(shop.shopDomain, PRODUCT_GID);

    await expect(
      db.productSnapshot.count({ where: { shopId: shop.id } }),
    ).resolves.toBe(1);
  });

  it("derives a product GID from either webhook payload shape", () => {
    expect(
      productGidFromWebhookPayload({ admin_graphql_api_id: PRODUCT_GID }),
    ).toBe(PRODUCT_GID);
    expect(productGidFromWebhookPayload({ id: 42 })).toBe(
      "gid://shopify/Product/42",
    );
    expect(productGidFromWebhookPayload({})).toBeNull();
  });
});
