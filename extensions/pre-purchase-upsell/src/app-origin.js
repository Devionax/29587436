/**
 * Absolute origin of the deployed app backend, without a trailing slash.
 *
 * Shopify does not proxy checkout extension network calls and the extension
 * build injects no environment variables, so this value is compiled into the
 * bundle. Set it to the same origin as SHOPIFY_APP_URL before deploying the
 * extension. While it stays empty the extension renders nothing and logs one
 * warning, so a build can never call an unintended host.
 */
export const APP_ORIGIN = "";
