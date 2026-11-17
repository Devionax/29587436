import type { ActionFunctionArgs } from "react-router";
import { handlePostPurchaseOffers } from "../services/post-purchase-api.server";

/** POST /api/post-purchase/offers — post-purchase `ShouldRender` evaluation. */
export const action = async ({ request }: ActionFunctionArgs) =>
  handlePostPurchaseOffers(request);
