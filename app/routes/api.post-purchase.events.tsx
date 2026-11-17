import type { ActionFunctionArgs } from "react-router";
import { ingestPostPurchaseEvents } from "../services/checkout-events.server";

/** Analytics for the post-purchase extension; surface and experience are forced. */

export const action = async ({ request }: ActionFunctionArgs) =>
  ingestPostPurchaseEvents(request);
