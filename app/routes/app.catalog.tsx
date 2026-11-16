import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { searchProducts, syncProductByGid } from "../services/catalog.server";
import { requireShopContext } from "../services/tenant.server";
import { isProductGid } from "../utils/gid";
import { logger, toErrorMessage } from "../utils/logger.server";

const STATUS_TONE = {
  ACTIVE: "success",
  DRAFT: "warning",
  ARCHIVED: "critical",
  UNLISTED: "neutral",
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, admin } = await requireShopContext(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const after = url.searchParams.get("after") || null;

  try {
    const page = await searchProducts(admin, { query, after, first: 20 });
    const productGids = page.products.map((product) => product.productGid);
    const snapshots = await db.productSnapshot.findMany({
      where: { shopId: shop.id, productGid: { in: productGids } },
      select: { productGid: true },
    });

    return {
      query,
      page,
      savedGids: snapshots.map((snapshot) => snapshot.productGid),
      error: null as string | null,
    };
  } catch (error) {
    logger.error("Catalog page could not load products", {
      shop: shop.shopDomain,
      error: toErrorMessage(error),
    });
    return {
      query,
      page: { products: [], hasNextPage: false, endCursor: null },
      savedGids: [] as string[],
      error: "Could not load products from Shopify. Try again.",
    };
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireShopContext(request);
  const form = await request.formData();
  const productGid = String(form.get("productGid") ?? "");

  if (!isProductGid(productGid)) {
    return { ok: false as const, productGid, error: "Invalid product id." };
  }

  try {
    const product = await syncProductByGid(admin, shop.id, productGid);
    if (!product) {
      return {
        ok: false as const,
        productGid,
        error: "That product no longer exists in Shopify.",
      };
    }
    return { ok: true as const, productGid, error: null };
  } catch (error) {
    logger.error("Product snapshot sync failed", {
      shop: shop.shopDomain,
      productGid,
      error: toErrorMessage(error),
    });
    return {
      ok: false as const,
      productGid,
      error: "Could not save this product. Try again.",
    };
  }
};

function formatPrice(amount: string | null, currency: string | null): string {
  if (!amount) return "No price";
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;

  if (!currency) return String(value);

  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

export default function Catalog() {
  const { query, page, savedGids, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(query);

  const pendingGid =
    fetcher.state !== "idle"
      ? String(fetcher.formData?.get("productGid") ?? "")
      : null;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Saved to app catalog");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const runSearch = () => {
    const trimmed = search.trim();
    navigate(trimmed ? `/app/catalog?q=${encodeURIComponent(trimmed)}` : "/app/catalog");
  };

  const nextPage = () => {
    if (!page.endCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("after", page.endCursor);
    navigate(`/app/catalog?${params.toString()}`);
  };

  return (
    <s-page heading="Catalog">
      <s-section heading="Find products">
        <s-stack direction="inline" gap="base">
          <s-text-field
            label="Search your Shopify catalog"
            labelAccessibilityVisibility="exclusive"
            placeholder="Product title, tag, or SKU"
            value={search}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
          <s-button onClick={runSearch}>Search</s-button>
        </s-stack>
        <s-paragraph>
          Products are read live from Shopify. Saving a product stores a local
          snapshot (title, image, price, variant availability) so storefront
          offers render without calling Shopify.
        </s-paragraph>
      </s-section>

      {error && (
        <s-banner tone="critical" heading="Catalog unavailable">
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      )}

      {!error && page.products.length === 0 && (
        <s-section>
          <s-paragraph>
            {query
              ? `No products matched "${query}".`
              : "No products were found in this store."}
          </s-paragraph>
        </s-section>
      )}

      <s-stack direction="block" gap="base">
        {page.products.map((product) => {
          const saved = savedGids.includes(product.productGid);
          const tone = STATUS_TONE[product.status as keyof typeof STATUS_TONE] ?? "neutral";
          const price = formatPrice(product.priceMin, product.currencyCode);

          return (
            <s-section key={product.productGid} heading={product.title}>
              <s-stack direction="inline" gap="base">
                {product.imageUrl ? (
                  <s-thumbnail
                    src={product.imageUrl}
                    alt={product.title}
                    size="base"
                  />
                ) : null}
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="base">
                    <s-badge tone={tone}>{product.status.toLowerCase()}</s-badge>
                    {saved ? (
                      <s-badge tone="success">saved</s-badge>
                    ) : (
                      <s-badge tone="neutral">not saved</s-badge>
                    )}
                  </s-stack>
                  <s-paragraph>
                    {price} · {product.variants.length} variant
                    {product.variants.length === 1 ? "" : "s"} ·{" "}
                    {product.availableForSale ? "in stock" : "unavailable"}
                  </s-paragraph>
                  <s-stack direction="inline" gap="base">
                    <s-button
                      onClick={() =>
                        fetcher.submit(
                          { productGid: product.productGid },
                          { method: "post" },
                        )
                      }
                      {...(pendingGid === product.productGid
                        ? { loading: true }
                        : {})}
                    >
                      {saved ? "Refresh snapshot" : "Save to app catalog"}
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-stack>
            </s-section>
          );
        })}
      </s-stack>

      {page.hasNextPage && (
        <s-section>
          <s-button onClick={nextPage}>Next page</s-button>
        </s-section>
      )}

      {fetcher.data && !fetcher.data.ok && (
        <s-banner tone="critical" heading="Save failed">
          <s-paragraph>{fetcher.data.error}</s-paragraph>
        </s-banner>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
