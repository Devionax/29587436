import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useSearchParams,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { RuleEditor } from "../components/rule-editor";
import type { RuleDraft } from "../components/rule-editor";
import { ensureProductSnapshots, loadSnapshotViews } from "../services/catalog.server";
import { deleteRule, duplicateRule, getRule, updateRule } from "../services/rules.server";
import { requireShopContext } from "../services/tenant.server";
import {
  InvalidInputError,
  PlanLimitError,
  TenantResourceNotFoundError,
} from "../utils/errors";
import { logger, toErrorMessage } from "../utils/logger.server";
import { parseRuleForm } from "../utils/rule-form.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop, admin, entitlement } = await requireShopContext(request);
  const ruleId = params.ruleId ?? "";

  const rule = await getRule(shop.id, ruleId);
  if (!rule) {
    throw new Response("Rule not found", { status: 404 });
  }

  const productGids = [
    ...rule.triggers.map((trigger) => trigger.productGid),
    ...rule.offers.map((offer) => offer.productGid),
  ];
  await ensureProductSnapshots(admin, shop.id, productGids);
  const snapshots = await loadSnapshotViews(shop.id, productGids);

  const draft: RuleDraft = {
    name: rule.name,
    description: rule.description ?? "",
    status: rule.status === "ACTIVE" ? "ACTIVE" : rule.status === "PAUSED" ? "PAUSED" : "DRAFT",
    priority: rule.priority,
    matchMode: rule.matchMode,
    heading: rule.heading ?? "",
    maxOffers: rule.maxOffers === null ? "" : String(rule.maxOffers),
    showOnProductPage: rule.showOnProductPage,
    showOnCartPage: rule.showOnCartPage,
    triggers: rule.triggers.map((trigger) => {
      const snapshot = snapshots.get(trigger.productGid);
      const variant = snapshot?.variants.find(
        (item) => item.variantGid === trigger.variantGid,
      );
      return {
        productGid: trigger.productGid,
        variantGid: trigger.variantGid,
        title: snapshot?.title ?? trigger.productGid,
        imageUrl: snapshot?.imageUrl ?? null,
        variantTitle: trigger.variantGid ? (variant?.title ?? trigger.variantGid) : null,
      };
    }),
    offers: rule.offers.map((offer) => {
      const snapshot = snapshots.get(offer.productGid);
      const variant = snapshot?.variants.find(
        (item) => item.variantGid === offer.variantGid,
      );
      return {
        productGid: offer.productGid,
        variantGid: offer.variantGid,
        title: snapshot?.title ?? offer.productGid,
        imageUrl: snapshot?.imageUrl ?? null,
        variantTitle: variant?.title ?? "Variant",
        price: variant?.price ?? null,
        defaultQuantity: offer.defaultQuantity,
        minQuantity: offer.minQuantity,
        maxQuantity: offer.maxQuantity,
      };
    }),
  };

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    ruleStatus: rule.status,
    draft,
    maxOffers: entitlement.limits.maxOffersPerRule,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, admin } = await requireShopContext(request);
  const ruleId = params.ruleId ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  try {
    if (intent === "delete") {
      await deleteRule(shop.id, ruleId);
      return redirect("/app/rules");
    }

    if (intent === "duplicate") {
      const copy = await duplicateRule(shop.id, ruleId);
      return redirect(`/app/rules/${copy.id}`);
    }

    const parsed = parseRuleForm(form);
    if (!parsed.ok) {
      return { errors: parsed.errors };
    }

    const rule = await updateRule(shop.id, ruleId, parsed.input);
    await ensureProductSnapshots(admin, shop.id, [
      ...rule.triggers.map((trigger) => trigger.productGid),
      ...rule.offers.map((offer) => offer.productGid),
    ]);
    return redirect(`/app/rules/${rule.id}?saved=1`);
  } catch (error) {
    if (error instanceof TenantResourceNotFoundError) {
      throw new Response("Rule not found", { status: 404 });
    }
    if (error instanceof InvalidInputError || error instanceof PlanLimitError) {
      return { errors: { form: error.message } };
    }
    logger.error("Rule update failed", {
      shop: shop.shopDomain,
      ruleId,
      intent,
      error: toErrorMessage(error),
    });
    return { errors: { form: "Could not save the rule. Try again." } };
  }
};

export default function EditRule() {
  const { ruleId, ruleName, ruleStatus, draft, maxOffers } =
    useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const submit = useSubmit();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  useEffect(() => {
    if (searchParams.get("saved") === "1") {
      shopify.toast.show("Rule saved");
    }
  }, [searchParams, shopify]);

  return (
    <s-stack direction="block" gap="base">
      <RuleEditor
        mode="edit"
        initial={draft}
        errors={data?.errors}
        cancelHref="/app/rules"
        maxOffers={maxOffers}
      />

      <s-section heading="Rule actions">
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={() =>
              submit(
                { intent: "duplicate" },
                { method: "post", action: `/app/rules/${ruleId}` },
              )
            }
          >
            Duplicate
          </s-button>
          <s-button
            tone="critical"
            onClick={() => {
              const confirmed = window.confirm(
                `Delete "${ruleName}"? This cannot be undone.`,
              );
              if (!confirmed) return;
              submit(
                { intent: "delete" },
                { method: "post", action: `/app/rules/${ruleId}` },
              );
            }}
          >
            Delete rule
          </s-button>
        </s-stack>
        <s-paragraph>
          Rule id {ruleId} · status {ruleStatus.toLowerCase()}
        </s-paragraph>
      </s-section>

      <s-stack direction="inline" gap="base">
        <s-link href="/app/rules">Back to rules</s-link>
        <s-button variant="tertiary" onClick={() => navigate("/app/catalog")}>
          Browse catalog
        </s-button>
      </s-stack>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
