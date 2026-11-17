import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  getExperienceSupport,
  noExperienceReason,
} from "../services/placements.server";
import { getSettings, updateSettings } from "../services/settings.server";
import { listRules } from "../services/rules.server";
import { requireShopContext } from "../services/tenant.server";
import { InvalidInputError } from "../utils/errors";
import { logger, toErrorMessage } from "../utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, entitlement } = await requireShopContext(request);
  const [settings, offers] = await Promise.all([
    getSettings(shop.id),
    listRules(shop.id),
  ]);

  const support = getExperienceSupport(shop);
  const active = offers.filter((offer) => offer.status === "ACTIVE");

  return {
    shop: {
      name: shop.name,
      domain: shop.shopDomain,
      currency: shop.currencyCode,
      plan: shop.shopifyPlan,
      isPlus: shop.isPlus,
    },
    settings,
    experiences: support,
    blockedReason: noExperienceReason(shop),
    plan: {
      id: entitlement.planId,
      name: entitlement.planName,
      status: entitlement.status,
      maxRules: entitlement.limits.maxRules,
      maxOffersPerRule: entitlement.limits.maxOffersPerRule,
    },
    usage: {
      total: offers.length,
      active: active.length,
      delivered: active.filter((offer) => offer.experiences.length > 0).length,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, entitlement } = await requireShopContext(request);
  const form = await request.formData();
  const maxOffers = Number(form.get("maxOffers") ?? 3);
  const planCap = entitlement.limits.maxOffersPerRule;

  if (Number.isInteger(maxOffers) && maxOffers > planCap) {
    return {
      ok: false as const,
      settings: null,
      error: `Your ${entitlement.planName} plan shows up to ${planCap} offers per placement. Lower this value or change plans.`,
    };
  }

  try {
    const settings = await updateSettings(shop.id, {
      enabled: form.get("enabled") !== null,
      defaultHeading: String(form.get("defaultHeading") ?? ""),
      maxOffers,
      productPageEnabled: form.get("productPageEnabled") !== null,
      cartPageEnabled: form.get("cartPageEnabled") !== null,
    });
    return { ok: true as const, settings, error: null };
  } catch (error) {
    if (error instanceof InvalidInputError) {
      return { ok: false as const, settings: null, error: error.message };
    }
    logger.error("Settings update failed", {
      shop: shop.shopDomain,
      error: toErrorMessage(error),
    });
    return { ok: false as const, settings: null, error: "Could not save settings." };
  }
};

export default function Settings() {
  const { settings, shop, experiences, blockedReason, plan, usage } =
    useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const [enabled, setEnabled] = useState(settings.enabled);
  const [heading, setHeading] = useState(settings.defaultHeading);
  const [maxOffers, setMaxOffers] = useState(String(settings.maxOffers));
  const [productPageEnabled, setProductPageEnabled] = useState(
    settings.productPageEnabled,
  );
  const [cartPageEnabled, setCartPageEnabled] = useState(settings.cartPageEnabled);

  return (
    <s-page heading="Settings">
      <Form method="post">
        <s-stack direction="block" gap="base">
          {data?.ok && (
            <s-banner tone="success" heading="Settings saved">
              <s-paragraph>
                Storefront blocks pick up the change on the next page load or cart
                update. Checkout extensions read these values on the next checkout load.
              </s-paragraph>
            </s-banner>
          )}
          {data && !data.ok && data.error && (
            <s-banner tone="critical" heading="Settings not saved">
              <s-paragraph>{data.error}</s-paragraph>
            </s-banner>
          )}

          {blockedReason && (
            <s-banner tone="warning" heading="Checkout delivery is not available">
              <s-paragraph>{blockedReason}</s-paragraph>
            </s-banner>
          )}

          <s-section heading="Storefront placements">
            <s-stack direction="block" gap="base">
              <s-switch
                label="Show offers on product pages"
                name="productPageEnabled"
                checked={productPageEnabled}
                onChange={(event) => setProductPageEnabled(event.currentTarget.checked)}
              />
              <s-switch
                label="Show offers on cart pages"
                name="cartPageEnabled"
                checked={cartPageEnabled}
                onChange={(event) => setCartPageEnabled(event.currentTarget.checked)}
              />
              <s-paragraph color="subdued">
                These switches control the theme app extension blocks. Add the
                Upsellora product and cart page blocks in the theme editor once; after
                that, switching a placement off hides it here without touching the theme.
                Only active offers that target the placement are shown.
              </s-paragraph>
            </s-stack>
          </s-section>

          <s-section heading="Checkout behavior">
            <s-stack direction="block" gap="base">
              <s-switch
                label="Show offers in checkout"
                name="enabled"
                checked={enabled}
                onChange={(event) => setEnabled(event.currentTarget.checked)}
              />
              <s-paragraph color="subdued">
                Applies to the checkout experiences only. Product and cart page
                placements keep running when this is off. When off, both checkout
                experiences render nothing for buyers; offers, conditions, schedules,
                and analytics data are kept.
              </s-paragraph>
              <s-text-field
                label="Default heading"
                name="defaultHeading"
                value={heading}
                details="Used when a matching offer has no heading of its own."
                onInput={(event) => setHeading(event.currentTarget.value)}
              />
              <s-number-field
                label="Maximum offers shown at once"
                name="maxOffers"
                value={maxOffers}
                min={1}
                max={Math.min(10, plan.maxOffersPerRule)}
                details={`Your ${plan.name} plan allows up to ${plan.maxOffersPerRule} offers per placement.`}
                onChange={(event) => setMaxOffers(event.currentTarget.value)}
              />
            </s-stack>
          </s-section>

          <s-section heading="Checkout experiences">
            <s-stack direction="block" gap="base">
              <s-paragraph color="subdued">
                Each offer chooses one or both experiences. A placement only renders
                when the experience is available to this store, checkout offers are on,
                and the offer is active.
              </s-paragraph>

              <s-box padding="base" background="subdued" borderRadius="large-100">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text type="strong">Pre-purchase</s-text>
                    <s-badge
                      tone={experiences.PRE_PURCHASE.available ? "success" : "neutral"}
                    >
                      {experiences.PRE_PURCHASE.available ? "Available" : "Unavailable"}
                    </s-badge>
                  </s-stack>
                  <s-text color="subdued">{experiences.PRE_PURCHASE.note}</s-text>
                </s-stack>
              </s-box>

              <s-box padding="base" background="subdued" borderRadius="large-100">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text type="strong">Post-purchase</s-text>
                    <s-badge
                      tone={experiences.POST_PURCHASE.available ? "success" : "neutral"}
                    >
                      {experiences.POST_PURCHASE.available ? "Enabled" : "Disabled"}
                    </s-badge>
                  </s-stack>
                  <s-text color="subdued">{experiences.POST_PURCHASE.note}</s-text>
                </s-stack>
              </s-box>
            </s-stack>
          </s-section>

          <s-button type="submit" variant="primary" {...(saving ? { loading: true } : {})}>
            Save settings
          </s-button>
        </s-stack>
      </Form>

      <s-section slot="aside" heading="Store details">
        <s-stack direction="block" gap="small">
          <s-text type="strong">{shop.name ?? shop.domain}</s-text>
          <s-text color="subdued">{shop.domain}</s-text>
          <s-text color="subdued">
            {shop.plan ?? "Unknown Shopify plan"} · {shop.currency ?? "Unknown currency"}
          </s-text>
          <s-badge tone={shop.isPlus ? "info" : "neutral"}>
            {shop.isPlus ? "Shopify Plus" : "Non-Plus"}
          </s-badge>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Plan and usage">
        <s-stack direction="block" gap="small">
          <s-stack direction="inline" gap="small">
            <s-badge tone={plan.id === "FREE" ? "neutral" : "info"}>{plan.name}</s-badge>
            <s-badge tone={plan.status === "ACTIVE" ? "success" : "warning"}>
              {plan.status.toLowerCase()}
            </s-badge>
          </s-stack>
          <s-paragraph>
            {plan.maxRules === null
              ? "Unlimited offers"
              : `${usage.total} of ${plan.maxRules} offers used`}
          </s-paragraph>
          <s-paragraph>
            {usage.active} active offer{usage.active === 1 ? "" : "s"} ·{" "}
            {usage.delivered} delivered · up to {plan.maxOffersPerRule} products per
            offer
          </s-paragraph>
          <s-link href="/app/billing">Plan and billing</s-link>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Turning offers off">
        <s-paragraph>
          Switching a placement off hides the storefront block; switching checkout
          offers off stops both checkout experiences. Neither deletes offers, conditions,
          schedules, or analytics.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
