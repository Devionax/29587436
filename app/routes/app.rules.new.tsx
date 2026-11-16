import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { RuleEditor } from "../components/rule-editor";
import type { RuleDraft } from "../components/rule-editor";
import { ensureProductSnapshots } from "../services/catalog.server";
import { createRule } from "../services/rules.server";
import { requireShopContext } from "../services/tenant.server";
import { InvalidInputError, PlanLimitError } from "../utils/errors";
import { logger, toErrorMessage } from "../utils/logger.server";
import { parseRuleForm } from "../utils/rule-form.server";

const EMPTY_DRAFT: RuleDraft = {
  name: "",
  description: "",
  status: "DRAFT",
  priority: 100,
  matchMode: "ANY",
  heading: "",
  maxOffers: "",
  showOnProductPage: true,
  showOnCartPage: true,
  triggers: [],
  offers: [],
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { entitlement } = await requireShopContext(request);
  return { maxOffers: entitlement.limits.maxOffersPerRule };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireShopContext(request);
  const parsed = parseRuleForm(await request.formData());
  if (!parsed.ok) {
    return { errors: parsed.errors };
  }

  try {
    const rule = await createRule(shop.id, parsed.input);
    await ensureProductSnapshots(admin, shop.id, [
      ...rule.triggers.map((trigger) => trigger.productGid),
      ...rule.offers.map((offer) => offer.productGid),
    ]);
    return redirect(`/app/rules/${rule.id}?saved=1`);
  } catch (error) {
    if (error instanceof InvalidInputError || error instanceof PlanLimitError) {
      return { errors: { form: error.message } };
    }
    logger.error("Rule creation failed", {
      shop: shop.shopDomain,
      error: toErrorMessage(error),
    });
    return { errors: { form: "Could not save the rule. Try again." } };
  }
};

export default function NewRule() {
  const data = useActionData<typeof action>();
  const { maxOffers } = useLoaderData<typeof loader>();

  return (
    <RuleEditor
      mode="create"
      initial={EMPTY_DRAFT}
      errors={data?.errors}
      cancelHref="/app/rules"
      maxOffers={maxOffers}
    />
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
