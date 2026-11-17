import type { ActionFunctionArgs } from "react-router";
import { handleCheckoutOffers } from "../services/checkout-api.server";

/** POST /api/checkout/offers — pre-purchase extension offer evaluation. */
export const action = async ({ request }: ActionFunctionArgs) =>
  handleCheckoutOffers(request);
