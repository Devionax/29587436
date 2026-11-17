import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { RuleStatus } from "@prisma/client";
import { getRulePerformance } from "../services/analytics.server";
import { getExperienceSupport, noExperienceReason } from "../services/placements.server";
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
import {
  EmptyState,
  StatusBadge,
  experiencesLabel,
  formatMoney,
  formatNumber,
  sourceLabel,
} from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, entitlement } = await requireShopContext(request);
  const days = entitlement.limits.analyticsWindowDays;
  const support = getExperienceSupport(shop);

  const [offers, performance] = await Promise.all([
    listRules(shop.id),
    getRulePerformance(shop.id, days),
  ]);

  return {
    canCreate: support.PRE_PURCHASE.available || support.POST_PURCHASE.available,
    blockedReason: noExperienceReason(shop),
    plan: { id: entitlement.planId, name: entitlement.planName },
    limits: entitlement.limits,
    currency: shop.currencyCode,
    analyticsDays: days,
    offers: offers.map((offer) => {
      const stats = performance.get(offer.id);
      return {
        id: offer.id,
        name: offer.name,
        status: offer.status,
        priority: offer.priority,
        sources: offer.sources,
        experiences: offer.experiences.map((entry) => entry.experience),
        startsAt: offer.startsAt ? offer.startsAt.toISOString() : null,
        endsAt: offer.endsAt ? offer.endsAt.toISOString() : null,
        triggerCount: offer._count.triggers,
        offerCount: offer._count.offers,
        impressions: stats?.impressions ?? 0,
        adds: stats?.adds ?? 0,
        revenue: stats?.attributedRevenue ?? null,
      };
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const offerId = String(form.get("offerId") ?? "");

  if (!offerId) {
    return { ok: false as const, error: "Missing offer." };
  }

  try {
    if (intent === "activate" || intent === "pause") {
      await setRuleStatus(shop.id, offerId, intent === "activate" ? "ACTIVE" : "PAUSED");
      return { ok: true as const, error: null, upgrade: false };
    }

    if (intent === "duplicate") {
      await duplicateRule(shop.id, offerId);
      return { ok: true as const, error: null, upgrade: false };
    }

    if (intent === "delete") {
      await deleteRule(shop.id, offerId);
      return { ok: true as const, error: null, upgrade: false };
    }

    return { ok: false as const, error: "Unknown action.", upgrade: false };
  } catch (error) {
    if (error instanceof TenantResourceNotFoundError) {
      return { ok: false as const, error: "That offer no longer exists.", upgrade: false };
    }
    if (error instanceof InvalidInputError) {
      return { ok: false as const, error: error.message, upgrade: false };
    }
    if (error instanceof PlanLimitError) {
      return { ok: false as const, error: error.message, upgrade: true };
    }
    logger.error("Offer action failed", {
      shop: shop.shopDomain,
      intent,
      offerId,
      error: toErrorMessage(error),
    });
    return {
      ok: false as const,
      error: "Could not update the offer. Try again.",
      upgrade: false,
    };
  }
};

const TOAST: Record<string, string> = {
  activate: "Offer activated",
  pause: "Offer paused",
  duplicate: "Offer duplicated",
  delete: "Offer deleted",
};

const STATUS_OPTIONS: Array<{ value: "ALL" | RuleStatus; label: string }> = [
  { value: "ALL", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "PAUSED", label: "Paused" },
  { value: "ARCHIVED", label: "Archived" },
];

export default function OffersIndex() {
  const { offers, plan, limits, currency, analyticsDays, canCreate, blockedReason } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | RuleStatus>("ALL");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const intentRef = useRef<string | null>(null);
  const shownRef = useRef<typeof fetcher.data>(undefined);

  const pendingId =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("offerId") ?? "") : "";

  const error = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const upgradeSuggested =
    fetcher.data && !fetcher.data.ok && "upgrade" in fetcher.data && fetcher.data.upgrade;
  const atLimit = limits.maxRules !== null && offers.length >= limits.maxRules;
  const missingExperience = offers.filter(
    (offer) => offer.status === "ACTIVE" && offer.experiences.length === 0,
  );

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data !== shownRef.current) {
      shownRef.current = fetcher.data;
      shopify.toast.show(TOAST[intentRef.current ?? ""] ?? "Offer updated");
      setConfirmId(null);
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const run = (intent: string, offerId: string) => {
    intentRef.current = intent;
    fetcher.submit({ intent, offerId }, { method: "post" });
  };

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return offers.filter((offer) => {
      if (statusFilter !== "ALL" && offer.status !== statusFilter) return false;
      if (term && !offer.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [offers, search, statusFilter]);

  const confirming = offers.find((offer) => offer.id === confirmId) ?? null;

  return (
    <s-page heading="Offers">
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={atLimit || !canCreate}
        href="/app/offers/new"
      >
        Create offer
      </s-button>

      <s-stack direction="block" gap="base">
        {!canCreate && blockedReason && (
          <s-banner tone="warning" heading="Checkout offers are not available yet">
            <s-paragraph>{blockedReason}</s-paragraph>
          </s-banner>
        )}

        {missingExperience.length > 0 && (
          <s-banner tone="warning" heading="Some active offers are not delivered">
            <s-paragraph>
              {missingExperience.length} active offer
              {missingExperience.length === 1 ? " has" : "s have"} no checkout
              experience enabled, so buyers never see {missingExperience.length === 1 ? "it" : "them"}. Open the
              offer and choose an experience.
            </s-paragraph>
          </s-banner>
        )}

        {atLimit && (
          <s-banner tone="warning" heading="Offer limit reached">
            <s-paragraph>
              The {plan.name} plan allows {limits.maxRules} offer
              {limits.maxRules === 1 ? "" : "s"}. Delete an offer or{" "}
              <s-link href="/app/billing">change your plan</s-link> to add more.
            </s-paragraph>
          </s-banner>
        )}

        {error && (
          <s-banner tone="critical" heading="Offer action failed">
            <s-paragraph>{error}</s-paragraph>
            {upgradeSuggested && (
              <s-paragraph>
                <s-link href="/app/billing">Review plans and limits</s-link>
              </s-paragraph>
            )}
          </s-banner>
        )}

        {confirming && (
          <s-banner tone="critical" heading={`Delete "${confirming.name}"?`}>
            <s-stack direction="inline" gap="base">
              <s-text>
                Offers stop showing immediately. Analytics already recorded is kept.
              </s-text>
              <s-button
                tone="critical"
                {...(pendingId === confirming.id ? { loading: true } : {})}
                onClick={() => run("delete", confirming.id)}
              >
                Delete offer
              </s-button>
              <s-button onClick={() => setConfirmId(null)}>Cancel</s-button>
            </s-stack>
          </s-banner>
        )}

        {offers.length === 0 ? (
          <EmptyState
            title="No offers yet"
            action={
              <s-button variant="primary" href="/app/offers/new">
                Create your first offer
              </s-button>
            }
          >
            An offer connects products from your catalog to placements on your
            storefront. Start with a manual selection or let cart activity pick
            products automatically.
          </EmptyState>
        ) : (
          <>
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-search-field
                label="Search offers"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by offer name"
                value={search}
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
              <s-select
                label="Status"
                labelAccessibilityVisibility="exclusive"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.currentTarget.value as "ALL" | RuleStatus)
                }
              >
                {STATUS_OPTIONS.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>
              <s-text color="subdued">
                {filtered.length} of {offers.length} offers · last {analyticsDays} days
              </s-text>
            </s-stack>

            {filtered.length === 0 ? (
              <s-section accessibilityLabel="No matching offers">
                <s-paragraph color="subdued">
                  No offers match this search and status filter.
                </s-paragraph>
              </s-section>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Offer</s-table-header>
                  <s-table-header listSlot="inline">Status</s-table-header>
                  <s-table-header listSlot="labeled">Sources</s-table-header>
                  <s-table-header listSlot="labeled">Experiences</s-table-header>
                  <s-table-header listSlot="labeled">Impressions</s-table-header>
                  <s-table-header listSlot="labeled">Adds</s-table-header>
                  <s-table-header listSlot="labeled">Revenue</s-table-header>
                  <s-table-header listSlot="inline">Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {filtered.map((offer) => {
                    const pending = pendingId === offer.id;
                    return (
                      <s-table-row key={offer.id}>
                        <s-table-cell>
                          <s-stack direction="block" gap="none">
                            <s-link href={`/app/offers/${offer.id}`}>{offer.name}</s-link>
                            <s-text color="subdued">
                              {offer.offerCount} product
                              {offer.offerCount === 1 ? "" : "s"} ·{" "}
                              {offer.triggerCount} trigger
                              {offer.triggerCount === 1 ? "" : "s"}
                            </s-text>
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <StatusBadge status={offer.status} />
                        </s-table-cell>
                        <s-table-cell>
                          {offer.sources.map(sourceLabel).join(", ")}
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack direction="inline" gap="small" alignItems="center">
                            <s-text>{experiencesLabel(offer.experiences)}</s-text>
                            {offer.status === "ACTIVE" && offer.experiences.length === 0 && (
                              <s-badge tone="critical">Not delivered</s-badge>
                            )}
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>{formatNumber(offer.impressions)}</s-table-cell>
                        <s-table-cell>{formatNumber(offer.adds)}</s-table-cell>
                        <s-table-cell>{formatMoney(offer.revenue, currency)}</s-table-cell>
                        <s-table-cell>
                          <s-stack direction="inline" gap="small">
                            <s-link href={`/app/offers/${offer.id}`}>Edit</s-link>
                            <s-button
                              variant="tertiary"
                              {...(pending ? { loading: true } : {})}
                              onClick={() =>
                                run(
                                  offer.status === "ACTIVE" ? "pause" : "activate",
                                  offer.id,
                                )
                              }
                            >
                              {offer.status === "ACTIVE" ? "Pause" : "Activate"}
                            </s-button>
                            <s-button
                              variant="tertiary"
                              disabled={pending}
                              onClick={() => run("duplicate", offer.id)}
                            >
                              Duplicate
                            </s-button>
                            <s-button
                              variant="tertiary"
                              tone="critical"
                              disabled={pending}
                              onClick={() => setConfirmId(offer.id)}
                            >
                              Delete
                            </s-button>
                          </s-stack>
                        </s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
            )}
          </>
        )}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
