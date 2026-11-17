/**
 * Absolute origin of the deployed app backend, without a trailing slash.
 *
 * Shopify does not proxy extension network calls and does not inject
 * environment variables at build time, so this constant is compiled into the
 * bundle. Set it to the same origin as SHOPIFY_APP_URL before deploying.
 * While it stays empty the extension renders nothing and logs one warning.
 */
export const APP_ORIGIN = "";
