import type { Experience, Shop } from "@prisma/client";
import type { NormalizedOfferExperience } from "./experiences.server";

/**
 * Checkout delivery support.
 *
 * Upsellora delivers offers only through checkout experiences. Pre-purchase is
 * restricted by Shopify to Plus stores. Post-purchase is access-gated: Shopify
 * grants it per app and per store, and a deployment enables it only after that
 * grant by setting POST_PURCHASE_ENABLED=true. The flag defaults to false so a
 * deployment never implies access that was not granted.
 *
 * https://shopify.dev/docs/apps/build/checkout
 */

export function isPostPurchaseEnabled(): boolean {
  return process.env.POST_PURCHASE_ENABLED === "true";
}

export type ExperienceDelivery =
  | "CHECKOUT_UI_EXTENSION"
  | "POST_PURCHASE_EXTENSION";

export type ExperienceSupport = {
  /** Whether this store can use the experience at all. */
  available: boolean;
  /** Whether this build ships the experience. */
  implemented: boolean;
  delivery: ExperienceDelivery;
  /** Merchant-facing explanation. Always set when unavailable. */
  note: string;
};

export type ExperienceSupportMap = Record<Experience, ExperienceSupport>;

export function getExperienceSupport(
  shop: Pick<Shop, "isPlus">,
): ExperienceSupportMap {
  const postPurchaseEnabled = isPostPurchaseEnabled();

  return {
    PRE_PURCHASE: {
      available: shop.isPlus,
      implemented: true,
      delivery: "CHECKOUT_UI_EXTENSION",
      note: shop.isPlus
        ? "Shown in checkout through the pre-purchase checkout extension."
        : "Shopify restricts pre-purchase checkout extensions to Shopify Plus stores.",
    },
    POST_PURCHASE: {
      available: postPurchaseEnabled,
      implemented: true,
      delivery: "POST_PURCHASE_EXTENSION",
      note: postPurchaseEnabled
        ? "Shown after purchase on the post-purchase page. Shopify must grant post-purchase access to this app and store."
        : "Post-purchase offers are disabled for this app deployment. They stay off until Shopify grants post-purchase access and the deployment enables POST_PURCHASE_ENABLED.",
    },
  };
}

/** Experiences a new offer should start with, given what this store can use. */
export function defaultOfferExperiences(
  shop: Pick<Shop, "isPlus">,
): NormalizedOfferExperience[] {
  const support = getExperienceSupport(shop);
  const defaults: NormalizedOfferExperience[] = [];

  if (support.PRE_PURCHASE.available) {
    defaults.push({
      experience: "PRE_PURCHASE",
      enabled: true,
      headline: null,
      body: null,
      ctaLabel: null,
    });
  }
  if (support.POST_PURCHASE.available) {
    defaults.push({
      experience: "POST_PURCHASE",
      enabled: true,
      headline: null,
      body: null,
      ctaLabel: null,
    });
  }

  return defaults;
}

/** Explanation shown when a store cannot create an offer at all. */
export function noExperienceReason(shop: Pick<Shop, "isPlus">): string | null {
  const support = getExperienceSupport(shop);
  if (support.PRE_PURCHASE.available || support.POST_PURCHASE.available) {
    return null;
  }
  return "This store cannot show checkout offers yet. Pre-purchase requires Shopify Plus, and post-purchase requires Shopify to grant this app post-purchase access. Offers are saved as drafts and deliver nowhere until one experience is available.";
}
