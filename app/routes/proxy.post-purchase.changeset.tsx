import type { ActionFunctionArgs } from "react-router";
import { handlePostPurchaseChangeset } from "../services/post-purchase-api.server";

/** App Proxy alias: POST /apps/upsell/post-purchase/changeset. */
export const action = async ({ request }: ActionFunctionArgs) =>
  handlePostPurchaseChangeset(request);
