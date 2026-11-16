const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

export function isProductGid(value: string): boolean {
  return PRODUCT_GID.test(value);
}

export function isVariantGid(value: string): boolean {
  return VARIANT_GID.test(value);
}
