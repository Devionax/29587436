import { useState } from "react";
import { useFetcher } from "react-router";

/**
 * Live Shopify catalog picker for triggers and manual offer products.
 *
 * Search results come from the Admin API through /app/api/products; only GIDs,
 * titles and variant settings are sent back to the form. Prices and availability
 * are display-only and are re-read from Shopify snapshots server-side.
 */

export type PickerVariant = {
  variantGid: string;
  title: string;
  price: string;
  availableForSale: boolean;
};

export type PickerProduct = {
  productGid: string;
  title: string;
  imageUrl: string | null;
  variants: PickerVariant[];
};

type PickerResponse = {
  products?: PickerProduct[];
  error?: string;
};

export function ProductPicker({
  label,
  placeholder = "Product title, tag, or SKU",
  allowAnyVariant = false,
  excludeVariantGids = [],
  excludeProductGids = [],
  onPick,
}: {
  label: string;
  placeholder?: string;
  allowAnyVariant?: boolean;
  /** Variants already selected elsewhere in the offer. */
  excludeVariantGids?: string[];
  /** Products that may appear only once in the offer. */
  excludeProductGids?: string[];
  onPick: (product: PickerProduct, variantGid: string) => void;
}) {
  const fetcher = useFetcher<PickerResponse>();
  const [search, setSearch] = useState("");
  const [variantChoice, setVariantChoice] = useState<Record<string, string>>({});

  const runSearch = () => {
    fetcher.load(`/app/api/products?q=${encodeURIComponent(search.trim())}`);
  };

  const results = fetcher.data?.products ?? [];
  const loading = fetcher.state !== "idle";
  const excluded = new Set(excludeVariantGids);
  const usedProducts = new Set(excludeProductGids);

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="base" alignItems="end">
        <s-search-field
          label={label}
          labelAccessibilityVisibility="exclusive"
          placeholder={placeholder}
          value={search}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
        <s-button onClick={runSearch} {...(loading ? { loading: true } : {})}>
          Search products
        </s-button>
      </s-stack>

      {fetcher.data?.error && (
        <s-banner tone="critical" heading="Search failed">
          <s-paragraph>{fetcher.data.error}</s-paragraph>
        </s-banner>
      )}

      {!loading && fetcher.data && results.length === 0 && !fetcher.data.error && (
        <s-paragraph color="subdued">
          No products matched that search. Try a different title, tag, or SKU.
        </s-paragraph>
      )}

      {results.map((product) => {
        const available = product.variants.filter(
          (variant) => !excluded.has(variant.variantGid),
        );
        const choice =
          variantChoice[product.productGid] ??
          (allowAnyVariant ? "" : (available[0]?.variantGid ?? ""));
        const alreadyUsed =
          !allowAnyVariant && (usedProducts.has(product.productGid) || available.length === 0);

        return (
          <s-box
            key={product.productGid}
            padding="base"
            border="base"
            borderRadius="large-100"
          >
            <s-stack direction="block" gap="small">
              <s-stack direction="inline" gap="base" alignItems="center">
                {product.imageUrl ? (
                  <s-thumbnail src={product.imageUrl} alt={product.title} size="small" />
                ) : null}
                <s-stack direction="block" gap="none">
                  <s-text type="strong">{product.title}</s-text>
                  <s-text color="subdued">
                    {product.variants.length} variant
                    {product.variants.length === 1 ? "" : "s"}
                  </s-text>
                </s-stack>
              </s-stack>

              {alreadyUsed ? (
                <s-text color="subdued">
                  {usedProducts.has(product.productGid)
                    ? "This product is already part of the offer."
                    : "Every variant is already used in this offer."}
                </s-text>
              ) : (
                <s-stack direction="inline" gap="base" alignItems="end">
                  <s-select
                    label="Variant"
                    labelAccessibilityVisibility="exclusive"
                    value={choice}
                    onChange={(event) =>
                      setVariantChoice((current) => ({
                        ...current,
                        [product.productGid]: event.currentTarget.value,
                      }))
                    }
                  >
                    {allowAnyVariant && <s-option value="">Any variant</s-option>}
                    {available.map((variant) => (
                      <s-option key={variant.variantGid} value={variant.variantGid}>
                        {variant.title} — {variant.price}
                        {variant.availableForSale ? "" : " (unavailable)"}
                      </s-option>
                    ))}
                  </s-select>
                  <s-button
                    disabled={!allowAnyVariant && !choice}
                    onClick={() => onPick(product, choice)}
                  >
                    Add
                  </s-button>
                </s-stack>
              )}
            </s-stack>
          </s-box>
        );
      })}
    </s-stack>
  );
}
