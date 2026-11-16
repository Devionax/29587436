import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { SubscriptionStatus } from "@prisma/client";
import db from "../db.server";
import { PlanLimitError } from "../utils/errors";
import { logger, toErrorMessage } from "../utils/logger.server";
import {
  DEFAULT_PLAN_ID,
  PLANS,
  UNKNOWN_PAID_PLAN_ID,
  planById,
  planByHandle,
} from "../utils/plans";
import type { PlanDefinition, PlanId, PlanLimits } from "../utils/plans";

/**
 * Entitlements for Shopify App Pricing.
 *
 * Shopify hosts plan selection and remains the billing source of truth. This
 * module reads the active subscription through the Admin API and caches it in
 * `Subscription` so storefront requests and enforcement never block on GraphQL.
 */

export const ENTITLEMENT_TTL_MS = 60 * 60 * 1000;

// AppPlanV2.pricingDetails is AppPricingDetails; planHandle lives on the
// recurring pricing variant. https://shopify.dev/docs/api/admin-graphql/2026-10/objects/AppPlanV2
const SUBSCRIPTION_QUERY = `#graphql
  query CurrentAppSubscription {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        currentPeriodEnd
        trialDays
        lineItems {
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                planHandle
              }
            }
          }
        }
      }
    }
  }
`;

export type Entitlement = {
  planId: PlanId;
  planName: string;
  status: SubscriptionStatus;
  limits: PlanLimits;
  source: "shopify" | "cache" | "default";
  verifiedAt: Date | null;
};

type SubscriptionNode = {
  id?: string | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
  lineItems?: {
    plan?: {
      pricingDetails?: {
        __typename?: string | null;
        planHandle?: string | null;
      } | null;
    } | null;
  }[];
};

function planDefinition(planId: string | null | undefined): PlanDefinition {
  return planById(planId) ?? PLANS[DEFAULT_PLAN_ID];
}

function freeEntitlement(
  status: SubscriptionStatus,
  source: Entitlement["source"],
  verifiedAt: Date | null,
): Entitlement {
  const plan = PLANS[DEFAULT_PLAN_ID];
  return {
    planId: plan.id,
    planName: plan.name,
    status,
    limits: plan.limits,
    source,
    verifiedAt,
  };
}

function entitlementFromPlan(
  plan: PlanDefinition,
  status: SubscriptionStatus,
  source: Entitlement["source"],
  verifiedAt: Date | null,
): Entitlement {
  return {
    planId: plan.id,
    planName: plan.name,
    status,
    limits: plan.limits,
    source,
    verifiedAt,
  };
}

function mapStatus(status: string | null | undefined): SubscriptionStatus {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "EXPIRED":
      return "EXPIRED";
    case "CANCELLED":
    case "DECLINED":
      return "CANCELLED";
    // Frozen and pending both mean no paid entitlement right now.
    case "FROZEN":
    case "PENDING":
    default:
      return "PENDING";
  }
}

function planForSubscription(subscription: SubscriptionNode): PlanDefinition {
  const handle = subscription.lineItems?.[0]?.plan?.pricingDetails?.planHandle ?? null;
  const matched = planByHandle(handle);
  if (matched) return matched;

  logger.warn("Active subscription has an unknown plan handle", { handle });
  return PLANS[UNKNOWN_PAID_PLAN_ID];
}

function firstActive(nodes: SubscriptionNode[]): SubscriptionNode | null {
  return nodes.find((node) => node.status === "ACTIVE") ?? null;
}

/**
 * Cached entitlement. Storefront and enforcement paths use this; it performs one
 * primary-key read and never calls Shopify.
 */
export async function getEntitlement(shopId: string): Promise<Entitlement> {
  const row = await db.subscription.findUnique({ where: { shopId } });
  if (!row) return freeEntitlement("PENDING", "default", null);

  const plan = planDefinition(row.planName);
  const effective = row.status === "ACTIVE" ? plan : PLANS[DEFAULT_PLAN_ID];

  return entitlementFromPlan(effective, row.status, "cache", row.lastVerifiedAt);
}

/**
 * Reconciles the cached plan with Shopify. Refreshes at most once per TTL unless
 * `force` is set (the billing page forces a refresh after plan selection).
 * Admin API failures fall back to the cached value rather than locking the
 * merchant out of the app.
 */
export async function syncEntitlement(
  shopId: string,
  admin: AdminApiContext,
  options: { force?: boolean } = {},
): Promise<Entitlement> {
  const row = await db.subscription.findUnique({ where: { shopId } });
  const fresh =
    row?.lastVerifiedAt &&
    Date.now() - row.lastVerifiedAt.getTime() < ENTITLEMENT_TTL_MS;

  if (row && fresh && !options.force) {
    return entitlementFromPlan(
      row.status === "ACTIVE" ? planDefinition(row.planName) : PLANS[DEFAULT_PLAN_ID],
      row.status,
      "cache",
      row.lastVerifiedAt,
    );
  }

  let subscription: SubscriptionNode | null = null;
  try {
    const response = await admin.graphql(SUBSCRIPTION_QUERY);
    const payload = (await response.json()) as {
      data?: {
        currentAppInstallation?: {
          activeSubscriptions?: SubscriptionNode[];
        } | null;
      };
      errors?: { message?: string }[];
    };

    if (payload.errors?.length) {
      throw new Error(payload.errors[0]?.message ?? "Subscription query failed");
    }

    subscription = firstActive(
      payload.data?.currentAppInstallation?.activeSubscriptions ?? [],
    );
  } catch (error) {
    logger.error("Could not read the app subscription", {
      error: toErrorMessage(error),
    });
    if (row) {
      return entitlementFromPlan(
        row.status === "ACTIVE" ? planDefinition(row.planName) : PLANS[DEFAULT_PLAN_ID],
        row.status,
        "cache",
        row.lastVerifiedAt,
      );
    }
    return freeEntitlement("PENDING", "default", null);
  }

  const now = new Date();
  const status = mapStatus(subscription?.status);
  const plan = subscription ? planForSubscription(subscription) : PLANS[DEFAULT_PLAN_ID];
  const effectiveStatus = subscription ? status : "PENDING";
  const periodEnd = subscription?.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd)
    : null;

  await db.subscription.upsert({
    where: { shopId },
    create: {
      shopId,
      planName: plan.id,
      status: effectiveStatus,
      shopifySubscriptionGid: subscription?.id ?? null,
      currentPeriodEnd:
        periodEnd && !Number.isNaN(periodEnd.getTime()) ? periodEnd : null,
      lastVerifiedAt: now,
    },
    update: {
      planName: plan.id,
      status: effectiveStatus,
      shopifySubscriptionGid: subscription?.id ?? null,
      currentPeriodEnd:
        periodEnd && !Number.isNaN(periodEnd.getTime()) ? periodEnd : null,
      lastVerifiedAt: now,
    },
  });

  return entitlementFromPlan(
    effectiveStatus === "ACTIVE" ? plan : PLANS[DEFAULT_PLAN_ID],
    effectiveStatus,
    "shopify",
    now,
  );
}

/** Reads the cached plan; callers that must not call Shopify use this. */
export async function assertRuleCapacity(shopId: string): Promise<void> {
  const [entitlement, total] = await Promise.all([
    getEntitlement(shopId),
    db.recommendationRule.count({ where: { shopId } }),
  ]);

  const max = entitlement.limits.maxRules;
  if (max !== null && total >= max) {
    throw new PlanLimitError(
      "RULES",
      `The ${entitlement.planName} plan allows ${max} recommendation rule${max === 1 ? "" : "s"}. Upgrade your plan or delete a rule first.`,
    );
  }
}

export async function assertActiveRuleCapacity(
  shopId: string,
  activatingRuleId: string,
): Promise<void> {
  const [entitlement, active] = await Promise.all([
    getEntitlement(shopId),
    db.recommendationRule.count({
      where: { shopId, status: "ACTIVE", id: { not: activatingRuleId } },
    }),
  ]);

  const max = entitlement.limits.maxActiveRules;
  if (max !== null && active >= max) {
    throw new PlanLimitError(
      "ACTIVE_RULES",
      `The ${entitlement.planName} plan allows ${max} active rule${max === 1 ? "" : "s"}. Pause another rule or upgrade first.`,
    );
  }
}

export async function assertOfferCapacity(
  shopId: string,
  offerCount: number,
): Promise<void> {
  const entitlement = await getEntitlement(shopId);
  const max = entitlement.limits.maxOffersPerRule;

  if (offerCount > max) {
    throw new PlanLimitError(
      "OFFERS",
      `The ${entitlement.planName} plan allows ${max} offer${max === 1 ? "" : "s"} per rule. Remove ${offerCount - max} offer${offerCount - max === 1 ? "" : "s"} or upgrade.`,
    );
  }
}
