import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getSettings, updateSettings } from "../services/settings.server";
import { requireShopContext } from "../services/tenant.server";
import { InvalidInputError } from "../utils/errors";
import { logger, toErrorMessage } from "../utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  return { settings: await getSettings(shop.id) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const form = await request.formData();

  try {
    const settings = await updateSettings(shop.id, {
      enabled: form.get("enabled") !== null,
      defaultHeading: String(form.get("defaultHeading") ?? ""),
      maxOffers: Number(form.get("maxOffers") ?? 3),
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
  const { settings } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const [enabled, setEnabled] = useState(settings.enabled);
  const [productPage, setProductPage] = useState(settings.productPageEnabled);
  const [cartPage, setCartPage] = useState(settings.cartPageEnabled);
  const [heading, setHeading] = useState(settings.defaultHeading);
  const [maxOffers, setMaxOffers] = useState(String(settings.maxOffers));

  return (
    <s-page heading="Settings">
      <Form method="post">
        <s-stack direction="block" gap="base">
          {data?.ok && (
            <s-banner tone="success" heading="Settings saved">
              <s-paragraph>The storefront block uses these values immediately.</s-paragraph>
            </s-banner>
          )}
          {data && !data.ok && data.error && (
            <s-banner tone="critical" heading="Settings not saved">
              <s-paragraph>{data.error}</s-paragraph>
            </s-banner>
          )}

          <s-section heading="Storefront recommendations">
            <s-stack direction="block" gap="base">
              <s-switch
                label="Show recommendations in the storefront"
                name="enabled"
                checked={enabled}
                onChange={(event) => setEnabled(event.currentTarget.checked)}
              />
              <s-paragraph>
                When off, the theme block renders nothing for buyers. Rules keep their
                own settings.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-switch
                  label="Product pages"
                  name="productPageEnabled"
                  checked={productPage}
                  onChange={(event) => setProductPage(event.currentTarget.checked)}
                />
                <s-switch
                  label="Cart page / drawer"
                  name="cartPageEnabled"
                  checked={cartPage}
                  onChange={(event) => setCartPage(event.currentTarget.checked)}
                />
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Display">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Default heading"
                name="defaultHeading"
                value={heading}
                details="Used when a matching rule has no heading of its own."
                onInput={(event) => setHeading(event.currentTarget.value)}
              />
              <s-number-field
                label="Maximum offers shown at once"
                name="maxOffers"
                value={maxOffers}
                min={1}
                max={10}
                onChange={(event) => setMaxOffers(event.currentTarget.value)}
              />
            </s-stack>
          </s-section>

          <s-button type="submit" variant="primary" {...(saving ? { loading: true } : {})}>
            Save settings
          </s-button>
        </s-stack>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
