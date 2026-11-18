/**
 * Optional absolute origin of the deployed app backend, without a trailing
 * slash, e.g. "https://upsellora.example.com".
 *
 * Post-purchase requests normally go through the shop's App Proxy
 * (`https://{shop}/apps/upsell/post-purchase/*`), so this can stay empty: the
 * extension derives the host from the Shopify-issued token's shop domain.
 *
 * Set it only when the extension must call the app directly instead of through
 * the proxy. When set, requests go to `${APP_ORIGIN}/api/post-purchase/*`.
 */
export const APP_ORIGIN = "";
