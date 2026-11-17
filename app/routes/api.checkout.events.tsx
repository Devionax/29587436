import type { ActionFunctionArgs } from "react-router";
import { ingestCheckoutEvents } from "../services/checkout-events.server";

/** POST /api/checkout/events — pre-purchase extension analytics. */
export const action = async ({ request }: ActionFunctionArgs) =>
  ingestCheckoutEvents(request, "PRE_PURCHASE");
