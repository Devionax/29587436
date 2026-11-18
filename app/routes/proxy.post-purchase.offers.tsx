import type { ActionFunctionArgs } from "react-router";
import { handlePostPurchaseOffers } from "../services/post-purchase-api.server";

/**
 * App Proxy alias for the post-purchase extension:
 * POST /apps/upsell/post-purchase/offers -> /proxy/post-purchase/offers.
 *
 * Shopify signs the proxy request and the extension still sends the purchase
 * token, which the handler verifies; the shop comes from that token.
 */
export const action = async ({ request }: ActionFunctionArgs) =>
  handlePostPurchaseOffers(request);
