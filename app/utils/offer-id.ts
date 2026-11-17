const SYNTHETIC = /^auto:([A-Za-z0-9]{10,40}):(\d{1,20}):(\d{1,20})$/;
const PRODUCT_ID = /^gid:\/\/shopify\/Product\/(\d{1,20})$/;
const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/(\d{1,20})$/;

/**
 * Automatic offers are derived from cart activity at request time, so they have
 * no RecommendedProduct row. Their id embeds the rule and product identifiers so
 * analytics and attribution can resolve them without trusting client fields.
 */
export function syntheticOfferId(
  ruleId: string,
  productGid: string,
  variantGid: string,
): string | null {
  const product = PRODUCT_ID.exec(productGid);
  const variant = VARIANT_ID.exec(variantGid);
  if (!product || !variant) return null;
  return `auto:${ruleId}:${product[1]}:${variant[1]}`;
}

export type ParsedSyntheticOffer = {
  ruleId: string;
  productGid: string;
  variantGid: string;
};

export function parseSyntheticOfferId(value: string): ParsedSyntheticOffer | null {
  const match = SYNTHETIC.exec(value);
  if (!match) return null;
  return {
    ruleId: match[1]!,
    productGid: `gid://shopify/Product/${match[2]}`,
    variantGid: `gid://shopify/ProductVariant/${match[3]}`,
  };
}
