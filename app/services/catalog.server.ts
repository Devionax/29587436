import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { isProductGid } from "../utils/gid";
import { logger } from "../utils/logger.server";

/**
 * Catalog access.
 *
 * The product picker reads live from the Admin API. A local ProductSnapshot is
 * only written for products the merchant actually uses in a rule, so the
 * storefront endpoint never calls Shopify to render an offer.
 */

const MAX_VARIANTS_PER_PRODUCT = 100;

const PRODUCT_FIELDS = `#graphql
  fragment CatalogProductFields on Product {
    id
    title
    handle
    status
    featuredImage {
      url
    }
    priceRangeV2 {
      minVariantPrice {
        amount
        currencyCode
      }
      maxVariantPrice {
        amount
        currencyCode
      }
    }
    variants(first: ${MAX_VARIANTS_PER_PRODUCT}) {
      edges {
        node {
          id
          title
          price
          compareAtPrice
          availableForSale
        }
      }
    }
  }
`;

const PRODUCTS_PAGE_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query CatalogProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: TITLE) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          ...CatalogProductFields
        }
      }
    }
  }
`;

const PRODUCT_BY_ID_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query CatalogProduct($id: ID!) {
    product(id: $id) {
      ...CatalogProductFields
    }
  }
`;

type Money = { amount: string; currencyCode: string };

type ProductNode = {
  id: string;
  title: string;
  handle: string;
  status: string;
  featuredImage: { url: string } | null;
  priceRangeV2: {
    minVariantPrice: Money;
    maxVariantPrice: Money;
  };
  variants: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        price: string;
        compareAtPrice: string | null;
        availableForSale: boolean;
      };
    }>;
  };
};

type GraphqlEnvelope<T> = { data?: T; errors?: Array<{ message: string }> };

export type CatalogVariant = {
  variantGid: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  availableForSale: boolean;
  position: number;
};

export type CatalogProduct = {
  productGid: string;
  title: string;
  handle: string;
  status: string;
  imageUrl: string | null;
  availableForSale: boolean;
  priceMin: string | null;
  priceMax: string | null;
  currencyCode: string | null;
  variants: CatalogVariant[];
};

export type ProductPage = {
  products: CatalogProduct[];
  hasNextPage: boolean;
  endCursor: string | null;
};

function graphqlError(errors: Array<{ message: string }> | undefined): never {
  throw new Error(
    `Shopify catalog query failed: ${(errors ?? [])
      .map((error) => error.message)
      .join("; ")}`,
  );
}

export function normalizeProduct(node: ProductNode): CatalogProduct {
  const variants = node.variants.edges.map((edge, index) => ({
    variantGid: edge.node.id,
    title: edge.node.title,
    price: edge.node.price,
    compareAtPrice: edge.node.compareAtPrice,
    availableForSale: edge.node.availableForSale,
    position: index,
  }));

  return {
    productGid: node.id,
    title: node.title,
    handle: node.handle,
    status: node.status,
    imageUrl: node.featuredImage?.url ?? null,
    availableForSale: variants.some((variant) => variant.availableForSale),
    priceMin: node.priceRangeV2?.minVariantPrice.amount ?? null,
    priceMax: node.priceRangeV2?.maxVariantPrice.amount ?? null,
    currencyCode: node.priceRangeV2?.minVariantPrice.currencyCode ?? null,
    variants,
  };
}

export async function searchProducts(
  admin: AdminApiContext,
  options: { query?: string | null; after?: string | null; first?: number },
): Promise<ProductPage> {
  const response = await admin.graphql(PRODUCTS_PAGE_QUERY, {
    variables: {
      first: Math.min(Math.max(options.first ?? 20, 1), 50),
      after: options.after || null,
      query: options.query || null,
    },
  });

  const body = (await response.json()) as GraphqlEnvelope<{
    products?: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: ProductNode }>;
    };
  }>;

  if (body.errors?.length) graphqlError(body.errors);
  const connection = body.data?.products;
  if (!connection) {
    throw new Error("Shopify catalog query returned no products connection");
  }

  return {
    products: connection.edges.map((edge) => normalizeProduct(edge.node)),
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: connection.pageInfo.endCursor,
  };
}

export async function fetchProduct(
  admin: AdminApiContext,
  productGid: string,
): Promise<CatalogProduct | null> {
  const response = await admin.graphql(PRODUCT_BY_ID_QUERY, {
    variables: { id: productGid },
  });

  const body = (await response.json()) as GraphqlEnvelope<{
    product?: ProductNode | null;
  }>;

  if (body.errors?.length) graphqlError(body.errors);
  const node = body.data?.product;
  return node ? normalizeProduct(node) : null;
}

/**
 * Writes the local projection used by the storefront endpoint.
 * Idempotent: variants are replaced inside one transaction.
 */
export async function upsertProductSnapshot(
  shopId: string,
  product: CatalogProduct,
): Promise<void> {
  const syncedAt = new Date();

  await db.$transaction(async (tx) => {
    const snapshot = await tx.productSnapshot.upsert({
      where: {
        shopId_productGid: { shopId, productGid: product.productGid },
      },
      create: {
        shopId,
        productGid: product.productGid,
        title: product.title,
        handle: product.handle,
        imageUrl: product.imageUrl,
        status: product.status,
        availableForSale: product.availableForSale,
        priceMin: product.priceMin,
        priceMax: product.priceMax,
        currencyCode: product.currencyCode,
        syncedAt,
      },
      update: {
        title: product.title,
        handle: product.handle,
        imageUrl: product.imageUrl,
        status: product.status,
        availableForSale: product.availableForSale,
        priceMin: product.priceMin,
        priceMax: product.priceMax,
        currencyCode: product.currencyCode,
        syncedAt,
      },
    });

    await tx.productVariantSnapshot.deleteMany({
      where: { productId: snapshot.id },
    });

    if (product.variants.length > 0) {
      await tx.productVariantSnapshot.createMany({
        data: product.variants.map((variant) => ({
          shopId,
          productId: snapshot.id,
          variantGid: variant.variantGid,
          title: variant.title,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
          availableForSale: variant.availableForSale,
          position: variant.position,
          syncedAt,
        })),
      });
    }
  });

  logger.info("Product snapshot stored", {
    shopId,
    productGid: product.productGid,
    variants: product.variants.length,
  });
}

export async function deleteProductSnapshot(
  shopId: string,
  productGid: string,
): Promise<void> {
  await db.productSnapshot.deleteMany({ where: { shopId, productGid } });
}

export async function syncProductByGid(
  admin: AdminApiContext,
  shopId: string,
  productGid: string,
): Promise<CatalogProduct | null> {
  const product = await fetchProduct(admin, productGid);

  if (!product) {
    await deleteProductSnapshot(shopId, productGid);
    return null;
  }

  await upsertProductSnapshot(shopId, product);
  return product;
}

export type SnapshotView = {
  productGid: string;
  title: string;
  imageUrl: string | null;
  status: string;
  variants: Array<{
    variantGid: string;
    title: string;
    price: string;
    availableForSale: boolean;
  }>;
};

/** Local projection of the given products, keyed by product GID. */
export async function loadSnapshotViews(
  shopId: string,
  productGids: string[],
): Promise<Map<string, SnapshotView>> {
  const unique = [...new Set(productGids.filter(isProductGid))];
  if (unique.length === 0) return new Map();

  const snapshots = await db.productSnapshot.findMany({
    where: { shopId, productGid: { in: unique } },
    include: { variants: { orderBy: { position: "asc" } } },
  });

  return new Map(
    snapshots.map((snapshot) => [
      snapshot.productGid,
      {
        productGid: snapshot.productGid,
        title: snapshot.title,
        imageUrl: snapshot.imageUrl,
        status: snapshot.status,
        variants: snapshot.variants.map((variant) => ({
          variantGid: variant.variantGid,
          title: variant.title,
          price: variant.price.toString(),
          availableForSale: variant.availableForSale,
        })),
      },
    ]),
  );
}

/**
 * Makes sure the products referenced by a rule have a local snapshot.
 *
 * Runs on rule save and on editor load (so existing rules render product
 * titles instead of raw GIDs). Snapshot failure must not block a rule write:
 * the storefront already skips offers without a snapshot.
 */
export async function ensureProductSnapshots(
  admin: AdminApiContext,
  shopId: string,
  productGids: string[],
  limit = 20,
): Promise<void> {
  const unique = [...new Set(productGids.filter(isProductGid))];
  if (unique.length === 0) return;

  const existing = await db.productSnapshot.findMany({
    where: { shopId, productGid: { in: unique } },
    select: { productGid: true },
  });
  const have = new Set(existing.map((snapshot) => snapshot.productGid));

  const missing = unique.filter((gid) => !have.has(gid)).slice(0, limit);

  await Promise.all(
    missing.map(async (gid) => {
      try {
        await syncProductByGid(admin, shopId, gid);
      } catch (error) {
        logger.warn("Could not snapshot product for rule", {
          shopId,
          productGid: gid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}
