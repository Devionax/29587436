import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getAnalyticsSummary, getRulePerformance } from "../services/analytics.server";
import { listRules } from "../services/rules.server";
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

  const [summary, offers, performance] = await Promise.all([
    getAnalyticsSummary(shop.id, days),
    listRules(shop.id),
    getRulePerformance(shop.id, days),
  ]);

  return {
    plan: { id: entitlement.planId, name: entitlement.planName },
    analyticsDays: days,
    currency: shop.currencyCode,
    summary,
    offerCount: offers.length,
    offers: offers
      .map((offer) => {
        const stats = performance.get(offer.id);
        return {
          id: offer.id,
          name: offer.name,
          status: offer.status,
          experiences: offer.experiences.map((entry) => entry.experience),
          impressions: stats?.impressions ?? 0,
          clicks: stats?.clicks ?? 0,
          addAttempts: stats?.addAttempts ?? 0,
          adds: stats?.adds ?? 0,
          accepts: stats?.accepts ?? 0,
          revenue: stats?.attributedRevenue ?? null,
        };
      })
      .sort(
        (a, b) =>
          b.impressions + b.adds - (a.impressions + a.adds) ||
          a.name.localeCompare(b.name),
      ),
  };
};

export default function Analytics() {
  const { summary, offers, offerCount, currency, analyticsDays, plan } =
    useLoaderData<typeof loader>();

  const hasEvents = summary.impressions > 0 || summary.addAttempts > 0;
  const revenue = formatMoney(summary.attributedRevenue, summary.attributedCurrency);

  return (
    <s-page heading="Analytics">
      <s-stack direction="block" gap="base">
        {offerCount === 0 ? (
          <EmptyState
            title="No offers to measure yet"
            action={
              <s-button variant="primary" href="/app/offers/new">
                Create an offer
              </s-button>
            }
          >
            Analytics starts collecting as soon as an active checkout offer is shown.
            Create an offer and enable a checkout experience for it.
          </EmptyState>
        ) : (
          <>
            <s-section heading="Performance">
              <s-stack direction="block" gap="base">
                <s-text color="subdued">
                  Last {analyticsDays} days · {plan.name} plan
                </s-text>
                <MetricGrid>
                  <Metric
                    label="Impressions"
                    value={formatNumber(summary.impressions)}
                    detail="Offers shown to buyers"
                  />
                  <Metric
                    label="Clicks"
                    value={formatNumber(summary.clicks)}
                    detail="Offer call-to-action presses"
                  />
                  <Metric
                    label="Add attempts"
                    value={formatNumber(summary.addAttempts)}
                    detail="Requests to add the offer product"
                  />
                  <Metric
                    label="Conversions"
                    value={formatNumber(summary.adds + summary.orderAccepts)}
                    detail="Confirmed cart adds and applied order changes"
                  />
                  <Metric
                    label="Declined offers"
                    value={formatNumber(summary.offerDeclines)}
                    detail="Buyers who continued without the post-purchase offer"
                  />
                  <Metric
                    label="Attributed revenue"
                    value={revenue}
                    detail={
                      summary.attributedOrders > 0
                        ? `${formatNumber(summary.attributedOrders)} order${
                            summary.attributedOrders === 1 ? "" : "s"
                          } · ${formatNumber(summary.attributedUnits)} units`
                        : null
                    }
                  />
                </MetricGrid>

                <s-grid
                  gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))"
                  gap="base"
                >
                  <s-box padding="base" background="subdued" borderRadius="large-100">
                    <s-stack direction="block" gap="small">
                      <s-text color="subdued">Add success rate</s-text>
                      <s-text type="strong">
                        {formatPercent(summary.adds, summary.addAttempts)}
                      </s-text>
                      <s-text color="subdued">
                        Confirmed adds divided by add requests.
                      </s-text>
                    </s-stack>
                  </s-box>
                  <s-box padding="base" background="subdued" borderRadius="large-100">
                    <s-stack direction="block" gap="small">
                      <s-text color="subdued">Add rate from impressions</s-text>
                      <s-text type="strong">
                        {summary.addRate === null ? "—" : `${summary.addRate}%`}
                      </s-text>
                      <s-text color="subdued">
                        Confirmed adds divided by impressions.
                      </s-text>
                    </s-stack>
                  </s-box>
                  <s-box padding="base" background="subdued" borderRadius="large-100">
                    <s-stack direction="block" gap="small">
                      <s-text color="subdued">Failed additions</s-text>
                      <s-text type="strong">{formatNumber(summary.addFailures)}</s-text>
                      <s-text color="subdued">
                        Buyers requested the product but Shopify rejected the change.
                      </s-text>
                    </s-stack>
                  </s-box>
                </s-grid>

                {!hasEvents && (
                  <s-banner tone="info" heading="No storefront activity yet">
                    <s-paragraph>
                      Metrics appear after buyers see an active checkout offer. If
                      checkout traffic continues and these stay zero, confirm
                      recommendations are enabled in{" "}
                      <s-link href="/app/settings">Settings</s-link>, the offer is
                      active, and it has an enabled experience.
                    </s-paragraph>
                  </s-banner>
                )}
              </s-stack>
            </s-section>

            <s-section heading="Offer performance">
              {hasEvents ? (
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Offer</s-table-header>
                    <s-table-header listSlot="inline">Status</s-table-header>
                    <s-table-header listSlot="labeled">Experiences</s-table-header>
                    <s-table-header listSlot="labeled">Impressions</s-table-header>
                    <s-table-header listSlot="labeled">Clicks</s-table-header>
                    <s-table-header listSlot="labeled">Add attempts</s-table-header>
                    <s-table-header listSlot="labeled">Adds</s-table-header>
                    <s-table-header listSlot="labeled">Accepts</s-table-header>
                    <s-table-header listSlot="labeled">Revenue</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {offers.map((offer) => (
                      <s-table-row key={offer.id}>
                        <s-table-cell>
                          <s-link href={`/app/offers/${offer.id}`}>{offer.name}</s-link>
                        </s-table-cell>
                        <s-table-cell>
                          <StatusBadge status={offer.status} />
                        </s-table-cell>
                        <s-table-cell>{experiencesLabel(offer.experiences)}</s-table-cell>
                        <s-table-cell>{formatNumber(offer.impressions)}</s-table-cell>
                        <s-table-cell>{formatNumber(offer.clicks)}</s-table-cell>
                        <s-table-cell>{formatNumber(offer.addAttempts)}</s-table-cell>
                        <s-table-cell>{formatNumber(offer.adds)}</s-table-cell>
                        <s-table-cell>{formatNumber(offer.accepts)}</s-table-cell>
                        <s-table-cell>{formatMoney(offer.revenue, currency)}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              ) : (
                <s-paragraph color="subdued">
                  Per-offer rows fill in as soon as checkout records impressions and
                  cart changes. {offerCount} offer
                  {offerCount === 1 ? " is" : "s are"} ready to measure.
                </s-paragraph>
              )}
            </s-section>

            <s-section heading="Most accepted products">
              {summary.topOffers.length === 0 ? (
                <s-paragraph color="subdued">
                  No offer product has been added to a cart in this period.
                </s-paragraph>
              ) : (
                <s-unordered-list>
                  {summary.topOffers.map((offer) => (
                    <s-list-item key={`${offer.productGid}|${offer.variantGid}`}>
                      {offer.title ?? offer.productGid} — {formatNumber(offer.adds)} add
                      {offer.adds === 1 ? "" : "s"}
                    </s-list-item>
                  ))}
                </s-unordered-list>
              )}
            </s-section>
          </>
        )}

        <s-section slot="aside" heading="How these numbers work">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Impressions are recorded when checkout renders an offer. Duplicate
              impressions from the same buyer session are discarded.
            </s-paragraph>
            <s-paragraph>
              Clicks count call-to-action presses. Add attempts count requests to add
              the product. Conversions are confirmed cart adds plus post-purchase
              changesets Shopify applied to the order.
            </s-paragraph>
            <s-paragraph>
              Attributed revenue is the line subtotal of offer products in orders
              that also carried the attribution tag. It is an association, not proof
              the offer caused the purchase.
            </s-paragraph>
            <s-paragraph>
              Order attribution needs the orders webhook and Shopify approval for
              protected customer data. Without it, the revenue figures stay empty
              while impressions, clicks and adds keep working.
            </s-paragraph>
            <s-paragraph>
              Your plan keeps {analyticsDays} days of history. Older events are not
              shown even though they remain stored.
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
