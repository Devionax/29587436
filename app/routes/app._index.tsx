import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { getAnalyticsSummary, getRulePerformance } from "../services/analytics.server";
import { getSettings } from "../services/settings.server";
import { listRules } from "../services/rules.server";
import {
  getExperienceSupport,
  noExperienceReason,
} from "../services/placements.server";
import { requireShopContext } from "../services/tenant.server";
import {
  EmptyState,
  Metric,
  MetricGrid,
  StatusBadge,
  experiencesLabel,
  formatMoney,
  formatNumber,
  formatPercent,
} from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, entitlement } = await requireShopContext(request);
  const days = entitlement.limits.analyticsWindowDays;

  const [settings, offers, performance, summary, snapshotCount] = await Promise.all([
    getSettings(shop.id),
    listRules(shop.id),
    getRulePerformance(shop.id, days),
    getAnalyticsSummary(shop.id, days),
    db.productSnapshot.count({ where: { shopId: shop.id } }),
  ]);

  const support = getExperienceSupport(shop);
  const active = offers.filter((offer) => offer.status === "ACTIVE");
  const canDeliver = support.PRE_PURCHASE.available || support.POST_PURCHASE.available;
  const delivered = active.filter((offer) => offer.experiences.length > 0);

  return {
    shop: {
      name: shop.name,
      domain: shop.shopDomain,
      currency: shop.currencyCode,
      isPlus: shop.isPlus,
      plan: shop.shopifyPlan,
    },
    settings,
    experiences: support,
    canDeliver,
    blockedReason: noExperienceReason(shop),
    plan: {
      id: entitlement.planId,
      name: entitlement.planName,
      maxRules: entitlement.limits.maxRules,
      analyticsDays: days,
    },
    usage: {
      total: offers.length,
      active: active.length,
      delivered: delivered.length,
      undelivered: active.length - delivered.length,
      snapshots: snapshotCount,
    },
    summary,
    activeOffers: active.map((offer) => {
      const stats = performance.get(offer.id);
      return {
        id: offer.id,
        name: offer.name,
        experiences: offer.experiences.map((entry) => entry.experience),
        clicks: stats?.clicks ?? 0,
        impressions: stats?.impressions ?? 0,
        addAttempts: stats?.addAttempts ?? 0,
        adds: stats?.adds ?? 0,
        revenue: stats?.attributedRevenue ?? null,
      };
    }),
  };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const {
    summary,
    settings,
    usage,
    plan,
    shop,
    activeOffers,
    experiences,
    canDeliver,
    blockedReason,
  } = data;

  const currency = summary.attributedCurrency ?? shop.currency;
  const revenue = formatMoney(summary.attributedRevenue, currency);
  const hasActivity = summary.impressions > 0 || summary.adds > 0;

  return (
    <s-page heading="Dashboard">
      <s-button
        slot="primary-action"
        variant="primary"
        href="/app/offers/new"
        {...(canDeliver ? {} : { disabled: true })}
      >
        Create offer
      </s-button>

      <s-stack direction="block" gap="base">
        {!canDeliver && (
          <s-banner tone="warning" heading="Checkout delivery is not available">
            <s-paragraph>{blockedReason}</s-paragraph>
          </s-banner>
        )}

        {!settings.enabled && (
          <s-banner tone="warning" heading="Checkout offers are off">
            <s-paragraph>
              Offers will not appear to buyers until checkout offers are enabled in{" "}
              <s-link href="/app/settings">Settings</s-link>.
            </s-paragraph>
          </s-banner>
        )}

        {settings.enabled && usage.undelivered > 0 && (
          <s-banner tone="info" heading="Some active offers are not delivered">
            <s-paragraph>
              {usage.undelivered} active offer
              {usage.undelivered === 1 ? " has" : "s have"} no enabled checkout
              experience, so buyers never see{" "}
              {usage.undelivered === 1 ? "it" : "them"}. Add an experience to each
              offer on the <s-link href="/app/offers">Offers</s-link> page.
            </s-paragraph>
          </s-banner>
        )}

        {settings.enabled && usage.active === 0 && usage.total > 0 && (
          <s-banner tone="info" heading="No active offers">
            <s-paragraph>
              Offers exist but none are active. Activate an offer from{" "}
              <s-link href="/app/offers">Offers</s-link> to start showing checkout
              recommendations.
            </s-paragraph>
          </s-banner>
        )}

        <s-section heading={`Performance · last ${plan.analyticsDays} days`}>
          <s-stack direction="block" gap="base">
            <MetricGrid>
              <Metric label="Impressions" value={formatNumber(summary.impressions)} />
              <Metric
                label="Clicks"
                value={formatNumber(summary.clicks)}
                detail="Offer CTA presses"
              />
              <Metric
                label="Add attempts"
                value={formatNumber(summary.addAttempts)}
                detail="Add-to-cart requests"
              />
              <Metric
                label="Conversions"
                value={formatNumber(summary.adds)}
                detail="Confirmed line additions"
              />
              <Metric
                label="Attributed revenue"
                value={revenue}
                detail={
                  summary.attributedOrders > 0
                    ? `${summary.attributedOrders} order${summary.attributedOrders === 1 ? "" : "s"}`
                    : null
                }
              />
            </MetricGrid>
            <s-paragraph color="subdued">
              Add success rate:{" "}
              {formatPercent(summary.adds, summary.addAttempts)}. Conversion rate from
              impressions: {formatPercent(summary.adds, summary.impressions)}. Failed
              additions: {formatNumber(summary.addFailures)}.
            </s-paragraph>
            {!hasActivity && (
              <s-paragraph color="subdued">
                No checkout activity recorded yet. Metrics appear after buyers reach
                checkout with offers placed. Attributed revenue also requires the
                orders webhook, which depends on Shopify approval for protected
                customer data.
              </s-paragraph>
            )}
          </s-stack>
        </s-section>

        {usage.total === 0 ? (
          <EmptyState
            title="Create your first offer"
            action={
              <s-button
                variant="primary"
                href="/app/offers/new"
                {...(canDeliver ? {} : { disabled: true })}
              >
                Create offer
              </s-button>
            }
          >
            Offers control which products appear, which checkout experience delivers
            them, and when they show. You can pick products manually or let recent cart
            activity choose them.
          </EmptyState>
        ) : (
          <s-section heading="Active offers">
            {activeOffers.length === 0 ? (
              <s-stack direction="block" gap="base">
                <s-paragraph color="subdued">
                  No active offers right now. Paused and draft offers are listed on the
                  Offers page.
                </s-paragraph>
                <s-link href="/app/offers">Manage offers</s-link>
              </s-stack>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Offer</s-table-header>
                  <s-table-header listSlot="labeled">Experiences</s-table-header>
                  <s-table-header listSlot="labeled">Impressions</s-table-header>
                  <s-table-header listSlot="labeled">Adds</s-table-header>
                  <s-table-header listSlot="labeled">Revenue</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {activeOffers.map((offer) => (
                    <s-table-row key={offer.id}>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-link href={`/app/offers/${offer.id}`}>{offer.name}</s-link>
                          <StatusBadge status="ACTIVE" />
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        {offer.experiences.length === 0 ? (
                          <s-badge tone="critical">Not delivered</s-badge>
                        ) : (
                          experiencesLabel(offer.experiences)
                        )}
                      </s-table-cell>
                      <s-table-cell>{formatNumber(offer.impressions)}</s-table-cell>
                      <s-table-cell>{formatNumber(offer.adds)}</s-table-cell>
                      <s-table-cell>
                        {formatMoney(offer.revenue, currency)}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-section>
        )}

        <s-section slot="aside" heading="Checkout checklist">
          <s-unordered-list>
            <s-list-item>Checkout offers {settings.enabled ? "enabled" : "disabled"}</s-list-item>
            <s-list-item>
              Pre-purchase{" "}
              {experiences.PRE_PURCHASE.available ? "available" : "unavailable (Plus only)"}
            </s-list-item>
            <s-list-item>
              Post-purchase{" "}
              {experiences.POST_PURCHASE.available ? "enabled" : "disabled"}
            </s-list-item>
            <s-list-item>
              {usage.delivered} of {usage.active} active offer
              {usage.active === 1 ? "" : "s"} delivered
            </s-list-item>
            <s-list-item>
              {settings.enabled && canDeliver && usage.delivered > 0
                ? "Ready for checkout traffic"
                : "Enable checkout offers and assign an experience to an active offer"}
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>
            Pre-purchase offers render through the checkout UI extension. Post-purchase
            offers render on Shopify&apos;s post-purchase page after payment.
          </s-paragraph>
        </s-section>

        <s-section slot="aside" heading="Store and plan">
          <s-stack direction="block" gap="small">
            <s-text type="strong">{shop.name ?? shop.domain}</s-text>
            <s-text color="subdued">{shop.domain}</s-text>
            <s-paragraph>
              {shop.plan ?? "Unknown Shopify plan"} ·{" "}
              {shop.currency ?? "Unknown currency"}
            </s-paragraph>
            <s-stack direction="inline" gap="small">
              <s-badge tone={plan.id === "FREE" ? "neutral" : "info"}>{plan.name}</s-badge>
              <s-badge tone={shop.isPlus ? "info" : "neutral"}>
                {shop.isPlus ? "Shopify Plus" : "Non-Plus"}
              </s-badge>
            </s-stack>
            <s-paragraph>
              {plan.maxRules === null
                ? "Unlimited offers"
                : `${usage.total} of ${plan.maxRules} offers used`}
            </s-paragraph>
            <s-link href="/app/billing">Plan and billing</s-link>
          </s-stack>
        </s-section>

        <s-section slot="aside" heading="Checkout delivery">
          <s-stack direction="block" gap="small">
            <s-text type="strong">Pre-purchase</s-text>
            <s-text color="subdued">{experiences.PRE_PURCHASE.note}</s-text>
            <s-text type="strong">Post-purchase</s-text>
            <s-text color="subdued">{experiences.POST_PURCHASE.note}</s-text>
            <s-paragraph color="subdued">
              Product and cart page upsell blocks are no longer delivered.
            </s-paragraph>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
