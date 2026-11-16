import db from "../db.server";
import type {
  CartLine,
  EngineProduct,
  EngineRule,
  RecommendationResult,
  Surface,
} from "./recommendation-engine";
import { recommendOffers } from "./recommendation-engine";

/**
 * Loads the shop's rules and product snapshots and runs the pure engine.
 * The caller is responsible for proving the shopId comes from a verified
 * Shopify signature — nothing here reads identity from a request.
 */

export type StorefrontRecommendations = {
  /** False until the merchant turns the feature on in Settings. */
  enabled: boolean;
  heading: string | null;
  offers: RecommendationResult["offers"];
  excluded: RecommendationResult["excluded"];
};

export async function getStorefrontRecommendations(
  shopId: string,
  options: { surface: Surface; cart: CartLine[]; limit?: number },
): Promise<StorefrontRecommendations> {
  const settings = await db.shopSettings.findUnique({ where: { shopId } });

  if (!settings?.enabled) {
    return { enabled: false, heading: null, offers: [], excluded: [] };
  }

  const surfaceField =
    options.surface === "PRODUCT_PAGE" ? "showOnProductPage" : "showOnCartPage";

  const rules = await db.recommendationRule.findMany({
    where: {
      shopId,
      status: "ACTIVE",
      [surfaceField]: true,
    },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
    include: {
      triggers: { orderBy: { createdAt: "asc" } },
      offers: { orderBy: [{ position: "asc" }, { id: "asc" }] },
    },
  });

  const engineRules: EngineRule[] = rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    status: rule.status,
    priority: rule.priority,
    matchMode: rule.matchMode,
    heading: rule.heading,
    maxOffers: rule.maxOffers,
    showOnProductPage: rule.showOnProductPage,
    showOnCartPage: rule.showOnCartPage,
    triggers: rule.triggers.map((trigger) => ({
      productGid: trigger.productGid,
      variantGid: trigger.variantGid,
    })),
    offers: rule.offers.map((offer) => ({
      id: offer.id,
      productGid: offer.productGid,
      variantGid: offer.variantGid,
      defaultQuantity: offer.defaultQuantity,
      minQuantity: offer.minQuantity,
      maxQuantity: offer.maxQuantity,
      position: offer.position,
      active: offer.active,
    })),
  }));

  const productGids = [...new Set(rules.flatMap((rule) => rule.offers.map((offer) => offer.productGid)))];

  const snapshots =
    productGids.length === 0
      ? []
      : await db.productSnapshot.findMany({
          where: { shopId, productGid: { in: productGids } },
          include: { variants: { orderBy: { position: "asc" } } },
        });

  const products: EngineProduct[] = snapshots.map((snapshot) => ({
    productGid: snapshot.productGid,
    title: snapshot.title,
    handle: snapshot.handle,
    imageUrl: snapshot.imageUrl,
    status: snapshot.status,
    availableForSale: snapshot.availableForSale,
    currencyCode: snapshot.currencyCode,
    variants: snapshot.variants.map((variant) => ({
      variantGid: variant.variantGid,
      title: variant.title,
      // Decimal(12,2): render money with a stable scale, never recomputed.
      price: variant.price.toFixed(2),
      compareAtPrice:
        variant.compareAtPrice === null ? null : variant.compareAtPrice.toFixed(2),
      availableForSale: variant.availableForSale,
    })),
  }));

  const result = recommendOffers({
    rules: engineRules,
    products,
    cart: options.cart,
    surface: options.surface,
    limit: options.limit ?? settings.maxOffers,
    defaultHeading: settings.defaultHeading,
  });

  return { enabled: true, ...result };
}
