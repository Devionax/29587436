import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { syncEntitlement } from "../services/entitlement.server";
import { requireShopContext } from "../services/tenant.server";
import { PLANS, planSelectionUrl } from "../utils/plans";

const STATUS_TONE = {
  ACTIVE: "success",
  PENDING: "warning",
  CANCELLED: "critical",
  EXPIRED: "critical",
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, admin } = await requireShopContext(request);
  // Plan selection happens on Shopify's hosted page, so refresh when the
  // merchant comes back instead of waiting for the cache TTL.
  const entitlement = await syncEntitlement(shop.id, admin, { force: true });

  const [ruleCount, activeRuleCount] = await Promise.all([
    db.recommendationRule.count({ where: { shopId: shop.id } }),
    db.recommendationRule.count({ where: { shopId: shop.id, status: "ACTIVE" } }),
  ]);

  const appHandle = process.env.SHOPIFY_APP_HANDLE ?? "";

  return {
    plan: {
      id: entitlement.planId,
      name: entitlement.planName,
      status: entitlement.status,
      verifiedAt: entitlement.verifiedAt?.toISOString() ?? null,
    },
    limits: entitlement.limits,
    usage: { ruleCount, activeRuleCount },
    planUrl: appHandle
      ? planSelectionUrl(shop.shopDomain, appHandle)
      : null,
    plans: Object.values(PLANS).map((plan) => ({
      id: plan.id,
      name: plan.name,
      limits: plan.limits,
    })),
  };
};

function limitLabel(value: number | null): string {
  return value === null ? "Unlimited" : String(value);
}

export default function Billing() {
  const { plan, limits, usage, planUrl, plans } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Plan and limits">
      <s-section heading="Current plan">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-badge tone={STATUS_TONE[plan.status]}>
              {plan.status.toLowerCase()}
            </s-badge>
            <s-badge tone={plan.id === "FREE" ? "neutral" : "info"}>
              {plan.name}
            </s-badge>
          </s-stack>
          <s-unordered-list>
            <s-list-item>
              Recommendation rules: {usage.ruleCount} of{" "}
              {limitLabel(limits.maxRules)}
            </s-list-item>
            <s-list-item>
              Active rules: {usage.activeRuleCount} of{" "}
              {limitLabel(limits.maxActiveRules)}
            </s-list-item>
            <s-list-item>
              Offers per rule: up to {limits.maxOffersPerRule}
            </s-list-item>
            <s-list-item>
              Analytics history: {limits.analyticsWindowDays} days
            </s-list-item>
          </s-unordered-list>
        </s-stack>
      </s-section>

      <s-section heading="Change plan">
        {planUrl ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Shopify hosts plan selection and billing. Prices, trials and
              payment methods are shown there, not in this app.
            </s-paragraph>
            <s-button href={planUrl} variant="primary" target="_blank">
              {plan.id === "FREE" ? "Choose a plan" : "Change plan in Shopify"}
            </s-button>
          </s-stack>
        ) : (
          <s-banner tone="warning" heading="Plan selection link is not configured">
            <s-paragraph>
              Set SHOPIFY_APP_HANDLE in .env to your app handle from the Partner
              Dashboard. Without it the app cannot build the Shopify plan
              selection link. See .env.example.
            </s-paragraph>
          </s-banner>
        )}
      </s-section>

      <s-section heading="What each plan includes">
        <s-unordered-list>
          {plans.map((entry) => (
            <s-list-item key={entry.id}>
              {entry.name}: {limitLabel(entry.limits.maxRules)} rule
              {entry.limits.maxRules === 1 ? "" : "s"}, up to{" "}
              {entry.limits.maxOffersPerRule} offers per rule,{" "}
              {entry.limits.analyticsWindowDays}-day analytics
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Billing details">
        <s-paragraph>
          Subscription status is read from Shopify and cached for one hour. The
          plan page refreshes it on every visit.
        </s-paragraph>
        {plan.verifiedAt ? (
          <s-paragraph>Last checked: {plan.verifiedAt}</s-paragraph>
        ) : (
          <s-paragraph>Not checked against Shopify yet.</s-paragraph>
        )}
        <s-paragraph>
          Downgrading never deletes rules. Rules above the new limit stay stored
          but must be paused, and offers must be removed, before they can be
          edited or activated.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
