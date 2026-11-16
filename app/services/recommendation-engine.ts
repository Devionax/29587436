/**
 * Recommendation engine.
 *
 * Pure and dependency-free on purpose: it takes already-loaded rules, product
 * snapshots and cart context and returns what may be shown. No database, no
 * Shopify calls, no pricing math. Everything it returns is derived from data
 * the caller trusts (rules and snapshots loaded server-side).
 *
 * Determinism contract: rules are evaluated by priority ASC, then rule id;
 * offers within a rule by position ASC, then offer id. The first qualifying
 * rule/offer for a variant wins, so the same input always yields the same order.
 */

export type Surface = "PRODUCT_PAGE" | "CART_PAGE";

export type RuleStatusName = "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
export type MatchModeName = "ANY" | "ALL";

export type EngineTrigger = {
  productGid: string;
  /** Empty string means "any variant of this product". */
  variantGid: string;
};

export type EngineOffer = {
  id: string;
  productGid: string;
  variantGid: string;
  defaultQuantity: number;
  minQuantity: number;
  maxQuantity: number;
  position: number;
  active: boolean;
};

export type EngineRule = {
  id: string;
  name: string;
  status: RuleStatusName;
  priority: number;
  matchMode: MatchModeName;
  heading: string | null;
  maxOffers: number | null;
  showOnProductPage: boolean;
  showOnCartPage: boolean;
  triggers: EngineTrigger[];
  offers: EngineOffer[];
};

export type EngineVariant = {
  variantGid: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  availableForSale: boolean;
};

export type EngineProduct = {
  productGid: string;
  title: string;
  handle: string;
  imageUrl: string | null;
  status: string;
  availableForSale: boolean;
  /** Shop currency of the snapshot prices; null when unknown. */
  currencyCode: string | null;
  variants: EngineVariant[];
};

export type CartLine = {
  /** Null when the caller only knows the product (e.g. a product page). */
  variantGid: string | null;
  productGid: string | null;
  quantity: number;
};

export type ExcludedReason =
  | "RULE_INACTIVE"
  | "SURFACE_DISABLED"
  | "NO_TRIGGER_MATCH"
  | "NO_TRIGGERS"
  | "OFFER_INACTIVE"
  | "OFFER_PRODUCT_MISSING"
  | "OFFER_PRODUCT_NOT_ACTIVE"
  | "OFFER_VARIANT_MISSING"
  | "OFFER_UNAVAILABLE"
  | "OFFER_ALREADY_IN_CART"
  | "DUPLICATE_OFFER"
  | "OVER_OFFER_CAP";

export type Recommendation = {
  ruleId: string;
  ruleName: string;
  offerId: string;
  productGid: string;
  variantGid: string;
  productTitle: string;
  variantTitle: string;
  handle: string;
  imageUrl: string | null;
  price: string;
  compareAtPrice: string | null;
  currencyCode: string | null;
  defaultQuantity: number;
  minQuantity: number;
  maxQuantity: number;
  position: number;
};

export type ExcludedOffer = {
  ruleId: string;
  offerId: string;
  variantGid: string;
  reason: ExcludedReason;
};

export type RecommendationResult = {
  /** Display heading from the first rule that produced an offer. */
  heading: string | null;
  offers: Recommendation[];
  excluded: ExcludedOffer[];
};

export type EngineInput = {
  rules: EngineRule[];
  products: EngineProduct[];
  cart: CartLine[];
  surface: Surface;
  /** Hard cap on returned offers, regardless of per-rule caps. */
  limit?: number;
  /** Shop-level fallback heading when a rule has none. */
  defaultHeading?: string | null;
};

const DEFAULT_LIMIT = 3;
const DEFAULT_HEADING = "You may also like";
function compareRules(a: EngineRule, b: EngineRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareOffers(a: EngineOffer, b: EngineOffer): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function triggerMatchesLine(trigger: EngineTrigger, line: CartLine): boolean {
  if (!line.productGid || line.productGid !== trigger.productGid) return false;
  if (!trigger.variantGid) return true;
  return line.variantGid === trigger.variantGid;
}

function ruleMatchesCart(rule: EngineRule, cart: CartLine[]): boolean {
  if (rule.triggers.length === 0) return false;
  if (rule.matchMode === "ALL") {
    return rule.triggers.every((trigger) =>
      cart.some((line) => triggerMatchesLine(trigger, line)),
    );
  }
  return rule.triggers.some((trigger) =>
    cart.some((line) => triggerMatchesLine(trigger, line)),
  );
}

function cartHasVariant(cart: CartLine[], variantGid: string): boolean {
  return cart.some((line) => line.variantGid === variantGid && line.quantity > 0);
}

export function recommendOffers(input: EngineInput): RecommendationResult {
  const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
  const products = new Map(input.products.map((product) => [product.productGid, product]));
  const cart = input.cart.filter((line) => line.quantity > 0);

  const offers: Recommendation[] = [];
  const excluded: ExcludedOffer[] = [];
  const claimedVariants = new Set<string>();
  let heading: string | null = null;

  const rules = [...input.rules].sort(compareRules);

  for (const rule of rules) {
    if (offers.length >= limit) break;

    const surfaceEnabled =
      input.surface === "PRODUCT_PAGE" ? rule.showOnProductPage : rule.showOnCartPage;

    let ruleBlocked: ExcludedReason | null = null;
    if (rule.status !== "ACTIVE") ruleBlocked = "RULE_INACTIVE";
    else if (!surfaceEnabled) ruleBlocked = "SURFACE_DISABLED";
    else if (rule.triggers.length === 0) ruleBlocked = "NO_TRIGGERS";
    else if (!ruleMatchesCart(rule, cart)) ruleBlocked = "NO_TRIGGER_MATCH";

    const ruleCap = Math.min(rule.maxOffers ?? limit, limit);
    let ruleOfferCount = 0;

    for (const offer of [...rule.offers].sort(compareOffers)) {
      let reason: ExcludedReason | null = ruleBlocked;

      if (!reason) {
        const product = products.get(offer.productGid);
        const variant = product?.variants.find(
          (item) => item.variantGid === offer.variantGid,
        );

        if (!offer.active) reason = "OFFER_INACTIVE";
        else if (!product) reason = "OFFER_PRODUCT_MISSING";
        else if (product.status !== "ACTIVE") reason = "OFFER_PRODUCT_NOT_ACTIVE";
        else if (!variant) reason = "OFFER_VARIANT_MISSING";
        else if (!product.availableForSale || !variant.availableForSale) {
          reason = "OFFER_UNAVAILABLE";
        } else if (cartHasVariant(cart, offer.variantGid)) {
          reason = "OFFER_ALREADY_IN_CART";
        } else if (claimedVariants.has(offer.variantGid)) {
          reason = "DUPLICATE_OFFER";
        } else if (ruleOfferCount >= ruleCap || offers.length >= limit) {
          reason = "OVER_OFFER_CAP";
        }
      }

      if (reason) {
        excluded.push({
          ruleId: rule.id,
          offerId: offer.id,
          variantGid: offer.variantGid,
          reason,
        });
        if (offers.length >= limit) break;
        continue;
      }

      const product = products.get(offer.productGid)!;
      const variant = product.variants.find(
        (item) => item.variantGid === offer.variantGid,
      )!;

      offers.push({
        ruleId: rule.id,
        ruleName: rule.name,
        offerId: offer.id,
        productGid: offer.productGid,
        variantGid: offer.variantGid,
        productTitle: product.title,
        variantTitle: variant.title,
        handle: product.handle,
        imageUrl: product.imageUrl,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        currencyCode: product.currencyCode,
        defaultQuantity: offer.defaultQuantity,
        minQuantity: offer.minQuantity,
        maxQuantity: offer.maxQuantity,
        position: offer.position,
      });

      claimedVariants.add(offer.variantGid);
      ruleOfferCount += 1;
      if (!heading) {
        heading =
          rule.heading?.trim() || input.defaultHeading?.trim() || DEFAULT_HEADING;
      }

      if (offers.length >= limit) break;
    }
  }

  return { heading, offers, excluded };
}
