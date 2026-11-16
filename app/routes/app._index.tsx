import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { requireShopContext } from "../services/tenant.server";

const STATUS_TONE = {
  INSTALLED: "success",
  PENDING: "warning",
  UNINSTALLED: "critical",
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, entitlement } = await requireShopContext(request);

  const [ruleCount, activeRuleCount, productCount] = await Promise.all([
    db.recommendationRule.count({ where: { shopId: shop.id } }),
    db.recommendationRule.count({ where: { shopId: shop.id, status: "ACTIVE" } }),
    db.productSnapshot.count({ where: { shopId: shop.id } }),
  ]);

  const installedAt = shop.installedAt
    ? `${new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(shop.installedAt)} UTC`
    : "Not installed";

  return {
    shop: {
      id: shop.id,
      domain: shop.shopDomain,
      name: shop.name,
      plan: shop.shopifyPlan,
      isPlus: shop.isPlus,
      status: shop.installationStatus,
      installedAt,
    },
    counts: { ruleCount, activeRuleCount, productCount },
    plan: {
      id: entitlement.planId,
      name: entitlement.planName,
      status: entitlement.status,
      maxRules: entitlement.limits.maxRules,
      maxOffersPerRule: entitlement.limits.maxOffersPerRule,
    },
  };
};

export default function Dashboard() {
  const { shop, counts, plan } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Smart Upsell">
      <s-section heading="Store connection">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-badge tone={STATUS_TONE[shop.status]}>
              {shop.status.toLowerCase()}
            </s-badge>
            <s-badge tone={shop.isPlus ? "info" : "neutral"}>
              {shop.isPlus ? "Shopify Plus" : "Non-Plus plan"}
            </s-badge>
            <s-badge tone={plan.id === "FREE" ? "neutral" : "success"}>
              {plan.name} plan
            </s-badge>
          </s-stack>
          <s-paragraph>
            Store: {shop.name ?? "Unnamed store"} ({shop.domain})
          </s-paragraph>
          <s-paragraph>Shopify plan: {shop.plan ?? "Unknown"}</s-paragraph>
          <s-paragraph>Tenant ID: {shop.id}</s-paragraph>
          <s-paragraph>Installed: {shop.installedAt}</s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="What this store can use">
        {shop.isPlus ? (
          <s-banner tone="info" heading="Checkout-step upsell is planned for this store">
            <s-paragraph>
              Shopify Plus stores are eligible for checkout UI extensions. That
              surface is not built yet; it is scheduled after the storefront
              experience.
            </s-paragraph>
          </s-banner>
        ) : (
          <s-banner tone="info" heading="Storefront recommendations only">
            <s-paragraph>
              Checkout-step upsell requires Shopify Plus. This store will use
              product-page and cart recommendations delivered through a theme
              app extension. No checkout placement will be offered.
            </s-paragraph>
          </s-banner>
        )}
      </s-section>

      <s-section heading="Setup progress">
        <s-unordered-list>
          <s-list-item>App installed and store connected</s-list-item>
          <s-list-item>
            App catalog: {counts.productCount} product
            {counts.productCount === 1 ? "" : "s"} saved
          </s-list-item>
          <s-list-item>
            Recommendation rules: {counts.ruleCount} created,{" "}
            {counts.activeRuleCount} active
          </s-list-item>
          <s-list-item>
            Storefront block is built; add it to your theme, then turn
            recommendations on in Settings
          </s-list-item>
          <s-list-item>
            Analytics: impressions and add-to-cart are recorded; attributed
            orders need Shopify order-data approval
          </s-list-item>
          <s-list-item>
            Plan: {plan.name} —{" "}
            {plan.maxRules === null ? "unlimited rules" : `${plan.maxRules} rule${plan.maxRules === 1 ? "" : "s"}`}
            , {plan.maxOffersPerRule} offers per rule
          </s-list-item>
          <s-list-item>
            Billing is managed by Shopify; see <s-link href="/app/billing">Plan</s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Current phase">
        <s-paragraph>
          Phases 1–11 are implemented: storefront offers, add-to-cart, analytics,
          Shopify-managed plans with server-side limits, and production
          hardening (idempotent webhooks, compliance endpoints, rate limits).
        </s-paragraph>
        <s-paragraph>
          Remaining: the Plus-only checkout extension and manual QA in a
          development store.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
