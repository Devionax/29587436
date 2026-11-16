/**
 * Plan catalog for Shopify App Pricing (managed pricing).
 *
 * Prices are configured in the Partner Dashboard, never in code. The handles
 * below must match the plan handles created there; the app reads the active
 * subscription's `planHandle` and maps it back to one of these rows.
 *
 * https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
 */

export type PlanId = "FREE" | "GROWTH" | "PRO";

export type PlanLimits = {
  /** null means unlimited. */
  maxRules: number | null;
  maxActiveRules: number | null;
  maxOffersPerRule: number;
  analyticsWindowDays: number;
};

export type PlanDefinition = {
  id: PlanId;
  name: string;
  /** Must match the plan handle in the Partner Dashboard. */
  handle: string;
  limits: PlanLimits;
};

export const PLANS: Record<PlanId, PlanDefinition> = {
  FREE: {
    id: "FREE",
    name: "Free",
    handle: "free",
    limits: {
      maxRules: 1,
      maxActiveRules: 1,
      maxOffersPerRule: 3,
      analyticsWindowDays: 7,
    },
  },
  GROWTH: {
    id: "GROWTH",
    name: "Growth",
    handle: "growth",
    limits: {
      maxRules: 10,
      maxActiveRules: 10,
      maxOffersPerRule: 10,
      analyticsWindowDays: 90,
    },
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    handle: "pro",
    limits: {
      maxRules: null,
      maxActiveRules: null,
      maxOffersPerRule: 20,
      analyticsWindowDays: 365,
    },
  },
};

export const DEFAULT_PLAN_ID: PlanId = "FREE";

/**
 * A paid subscription whose handle this build does not know is treated as the
 * lowest paid tier, so a misconfigured handle limits features instead of
 * silently granting the highest tier.
 */
export const UNKNOWN_PAID_PLAN_ID: PlanId = "GROWTH";

export function planById(value: string | null | undefined): PlanDefinition | null {
  if (!value) return null;
  return PLANS[value as PlanId] ?? null;
}

export function planByHandle(handle: string | null | undefined): PlanDefinition | null {
  if (!handle) return null;
  const normalized = handle.toLowerCase();
  return Object.values(PLANS).find((plan) => plan.handle === normalized) ?? null;
}

/**
 * Shopify hosts plan selection. The merchant returns to the app afterwards.
 * `appHandle` comes from the app URL in the Partner Dashboard
 * (SHOPIFY_APP_HANDLE in .env), not from this repository.
 */
export function planSelectionUrl(shopDomain: string, appHandle: string): string {
  const store = shopDomain.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${encodeURIComponent(store)}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
}
