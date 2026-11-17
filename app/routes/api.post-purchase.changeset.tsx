import type { ActionFunctionArgs } from "react-router";
import { handlePostPurchaseChangeset } from "../services/post-purchase-api.server";

/** POST /api/post-purchase/changeset — signed changeset for `applyChangeset`. */
export const action = async ({ request }: ActionFunctionArgs) =>
  handlePostPurchaseChangeset(request);
