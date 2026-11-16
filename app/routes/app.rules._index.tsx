import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  deleteRule,
  duplicateRule,
  listRules,
  setRuleStatus,
} from "../services/rules.server";
import { requireShopContext } from "../services/tenant.server";
import {
  InvalidInputError,
  PlanLimitError,
  TenantResourceNotFoundError,
} from "../utils/errors";
import { logger, toErrorMessage } from "../utils/logger.server";

const STATUS_TONE = {
  DRAFT: "neutral",
  ACTIVE: "success",
  PAUSED: "warning",
  ARCHIVED: "critical",
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, entitlement } = await requireShopContext(request);
  const rules = await listRules(shop.id);

  return {
    plan: { id: entitlement.planId, name: entitlement.planName },
    limits: entitlement.limits,
    rules: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      status: rule.status,
      priority: rule.priority,
      heading: rule.heading,
      showOnProductPage: rule.showOnProductPage,
      showOnCartPage: rule.showOnCartPage,
      triggerCount: rule._count.triggers,
      offerCount: rule._count.offers,
      updatedAt: rule.updatedAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const ruleId = String(form.get("ruleId") ?? "");

  if (!ruleId) {
    return { ok: false as const, error: "Missing rule." };
  }

  try {
    if (intent === "activate" || intent === "pause") {
      await setRuleStatus(shop.id, ruleId, intent === "activate" ? "ACTIVE" : "PAUSED");
      return { ok: true as const, error: null };
    }

    if (intent === "duplicate") {
      await duplicateRule(shop.id, ruleId);
      return { ok: true as const, error: null };
    }

    if (intent === "delete") {
      await deleteRule(shop.id, ruleId);
      return { ok: true as const, error: null };
    }

    return { ok: false as const, error: "Unknown action." };
  } catch (error) {
    if (error instanceof TenantResourceNotFoundError) {
      return { ok: false as const, error: "That rule no longer exists." };
    }
    if (error instanceof InvalidInputError) {
      return { ok: false as const, error: error.message };
    }
    if (error instanceof PlanLimitError) {
      return {
        ok: false as const,
        error: error.message,
        upgrade: true,
      };
    }
    logger.error("Rule action failed", {
      shop: shop.shopDomain,
      intent,
      ruleId,
      error: toErrorMessage(error),
    });
    return { ok: false as const, error: "Could not update the rule. Try again." };
  }
};

const TOAST: Record<string, string> = {
  activate: "Rule activated",
  pause: "Rule paused",
  duplicate: "Rule duplicated",
  delete: "Rule deleted",
};

export default function RulesIndex() {
  const { rules, plan, limits } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const intentRef = useRef<string | null>(null);
  const shownRef = useRef<typeof fetcher.data>(undefined);

  const pendingRuleId =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("ruleId") ?? "") : "";

  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const upgradeSuggested =
    fetcher.data && !fetcher.data.ok && "upgrade" in fetcher.data && fetcher.data.upgrade;
  const atRuleLimit =
    limits.maxRules !== null && rules.length >= limits.maxRules;

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.ok &&
      fetcher.data !== shownRef.current
    ) {
      shownRef.current = fetcher.data;
      shopify.toast.show(TOAST[intentRef.current ?? ""] ?? "Rule updated");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const run = (nextIntent: string, ruleId: string) => {
    if (nextIntent === "delete") {
      const confirmed = window.confirm(
        "Delete this rule? Offers will stop showing immediately.",
      );
      if (!confirmed) return;
    }
    intentRef.current = nextIntent;
    fetcher.submit({ intent: nextIntent, ruleId }, { method: "post" });
  };

  return (
    <s-page heading="Recommendation rules">
      <s-button
        variant="primary"
        disabled={atRuleLimit}
        onClick={() => navigate("/app/rules/new")}
      >
        New rule
      </s-button>

      {atRuleLimit && (
        <s-banner tone="warning" heading="Rule limit reached">
          <s-paragraph>
            The {plan.name} plan allows {limits.maxRules} rule
            {limits.maxRules === 1 ? "" : "s"}. Delete a rule or{" "}
            <s-link href="/app/billing">change your plan</s-link> to add more.
          </s-paragraph>
        </s-banner>
      )}

      {error && (
        <s-banner tone="critical" heading="Rule action failed">
          <s-paragraph>{error}</s-paragraph>
          {upgradeSuggested && (
            <s-paragraph>
              <s-link href="/app/billing">Review plans and limits</s-link>
            </s-paragraph>
          )}
        </s-banner>
      )}

      {rules.length === 0 ? (
        <s-section heading="No rules yet">
          <s-paragraph>
            A rule connects trigger products to offers. Create one to start showing
            recommendations in your storefront.
          </s-paragraph>
          <s-button onClick={() => navigate("/app/rules/new")}>Create the first rule</s-button>
        </s-section>
      ) : (
        <s-stack direction="block" gap="base">
          {rules.map((rule) => {
            const pending = pendingRuleId === rule.id;
            const tone = STATUS_TONE[rule.status] ?? "neutral";
            const placements = [
              rule.showOnProductPage ? "product page" : null,
              rule.showOnCartPage ? "cart page" : null,
            ].filter(Boolean);

            return (
              <s-section key={rule.id} heading={rule.name}>
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    <s-badge tone={tone}>{rule.status.toLowerCase()}</s-badge>
                    <s-badge tone="neutral">priority {rule.priority}</s-badge>
                  </s-stack>
                  <s-paragraph>
                    {rule.triggerCount} trigger{rule.triggerCount === 1 ? "" : "s"} ·{" "}
                    {rule.offerCount} offer{rule.offerCount === 1 ? "" : "s"} ·{" "}
                    {placements.length > 0
                      ? `shows on ${placements.join(" and ")}`
                      : "no placement enabled"}
                  </s-paragraph>
                  <s-stack direction="inline" gap="base">
                    <s-link href={`/app/rules/${rule.id}`}>Edit</s-link>
                    <s-button
                      variant="tertiary"
                      {...(pending ? { loading: true } : {})}
                      onClick={() =>
                        run(rule.status === "ACTIVE" ? "pause" : "activate", rule.id)
                      }
                    >
                      {rule.status === "ACTIVE" ? "Pause" : "Activate"}
                    </s-button>
                    <s-button
                      variant="tertiary"
                      disabled={pending}
                      onClick={() => run("duplicate", rule.id)}
                    >
                      Duplicate
                    </s-button>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      disabled={pending}
                      onClick={() => run("delete", rule.id)}
                    >
                      Delete
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-section>
            );
          })}
        </s-stack>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
