import type { LoaderFunctionArgs } from "react-router";
import { searchProducts } from "../services/catalog.server";
import { requireShopContext } from "../services/tenant.server";
import { logger, toErrorMessage } from "../utils/logger.server";

/** JSON product search for the offer wizard's product picker. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, admin } = await requireShopContext(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const after = url.searchParams.get("after") || null;

  try {
    const page = await searchProducts(admin, { query, after, first: 20 });
    return Response.json(page);
  } catch (error) {
    logger.error("Product picker search failed", {
      shop: shop.shopDomain,
      error: toErrorMessage(error),
    });
    return Response.json(
      { products: [], hasNextPage: false, endCursor: null, error: "Search failed." },
      { status: 502 },
    );
  }
};
