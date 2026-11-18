import type { ActionFunctionArgs } from "react-router";
import { ingestPostPurchaseEvents } from "../services/checkout-events.server";

/** App Proxy alias: POST /apps/upsell/post-purchase/events. */
export const action = async ({ request }: ActionFunctionArgs) =>
  ingestPostPurchaseEvents(request);
