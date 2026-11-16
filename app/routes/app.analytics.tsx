import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getAnalyticsSummary } from "../services/analytics.server";
import { requireShopContext } from "../services/tenant.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, entitlement } = await requireShopContext(request);
  const summary = await getAnalyticsSummary(
    shop.id,
    entitlement.limits.analyticsWindowDays,
  );

  let revenue: string | null = null;
  if (summary.attributedRevenue && summary.attributedCurrency) {
    try {
      revenue = new Intl.NumberFormat("en", {
        style: "currency",
        currency: summary.attributedCurrency,
      }).format(Number(summary.attributedRevenue));
    } catch {
      revenue = `${summary.attributedRevenue} ${summary.attributedCurrency}`;
    }
  }

  return { summary, revenue, planName: entitlement.planName };
};

export default function Analytics() {
  const { summary, revenue, planName } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Analytics">
      <s-section heading={`Last ${summary.windowDays} days`}>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The {planName} plan includes {summary.windowDays} days of analytics
            history in this view.
          </s-paragraph>
          <s-paragraph>
            Offer impressions: {summary.impressions.toLocaleString()}
          </s-paragraph>
          <s-paragraph>
            Add-to-cart attempts: {summary.addAttempts.toLocaleString()}
          </s-paragraph>
          <s-paragraph>
            Successful adds: {summary.adds.toLocaleString()}
          </s-paragraph>
          <s-paragraph>
            Failed adds: {summary.addFailures.toLocaleString()}
          </s-paragraph>
          <s-paragraph>
            Add rate:{" "}
            {summary.addRate === null ? "No data yet" : `${summary.addRate}%`}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Top accepted offers">
        {summary.topOffers.length === 0 ? (
          <s-paragraph>
            No offers have been added to a cart in this period. Offers are only
            recorded once a storefront block is rendered and a buyer adds one.
          </s-paragraph>
        ) : (
          <s-unordered-list>
            {summary.topOffers.map((offer) => (
              <s-list-item key={offer.variantGid || offer.productGid}>
                {offer.title ?? offer.productGid} — {offer.adds} add
                {offer.adds === 1 ? "" : "s"}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>

      <s-section heading="Attributed orders">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Orders containing at least one tagged offer:{" "}
            {summary.attributedOrders.toLocaleString()}
          </s-paragraph>
          <s-paragraph>
            Attributed units: {summary.attributedUnits.toLocaleString()}
          </s-paragraph>
          <s-paragraph>
            Attributed line revenue: {revenue ?? "No attributed orders yet"}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How to read this">
        <s-paragraph>
          Impressions come from the storefront block; adds are only counted after
          Shopify confirms the cart change. Duplicate impressions from the same
          browser session are discarded.
        </s-paragraph>
        <s-paragraph>
          Attributed revenue is the line subtotal of tagged offers, not additional
          revenue. Attribution is an association, not proof that the offer caused
          the purchase.
        </s-paragraph>
        <s-paragraph>
          Order attribution depends on the orders webhook, which requires Shopify
          approval for protected customer data. Until this app version has that
          access, this section stays empty.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
