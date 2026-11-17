import { useEffect, useState } from "react";
import type { ConditionField, ConditionOperator } from "@prisma/client";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  redirect,
  useActionData,
  useLoaderData,
  useSearchParams,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  OfferWizard,
  statusForWizard,
  toDateInput,
} from "../components/offer-wizard";
import type { OfferWizardDraft, WizardCondition } from "../components/offer-wizard";
import { ensureProductSnapshots, loadSnapshotViews } from "../services/catalog.server";
import { getConditionTree } from "../services/conditions.server";
import { listOfferExperiences } from "../services/experiences.server";
import { getExperienceSupport } from "../services/placements.server";
import { deleteRule, duplicateRule, getRule, updateRule } from "../services/rules.server";
import { requireShopContext } from "../services/tenant.server";
import {
  InvalidInputError,
  PlanLimitError,
  TenantResourceNotFoundError,
} from "../utils/errors";
import { toWizardExperiences } from "../utils/experience-view";
import { logger, toErrorMessage } from "../utils/logger.server";
import { parseRuleForm } from "../utils/rule-form.server";

const NUMERIC_OPS: ConditionOperator[] = ["EQ", "NEQ", "GT", "GTE", "LT", "LTE"];

/**
 * Maps one stored condition into the flat builder. Returns null when the row
 * (or a set of rows) cannot be represented without losing information, which
 * locks the condition step instead of rewriting the merchant's data.
 */
function toWizardCondition(condition: {
  field: ConditionField;
  operator: ConditionOperator;
  valueJson: unknown;
}): WizardCondition | null {
  switch (condition.field) {
    case "CART_SUBTOTAL":
    case "CART_LINE_COUNT":
    case "CART_TOTAL_QUANTITY": {
      if (!NUMERIC_OPS.includes(condition.operator)) return null;
      if (typeof condition.valueJson !== "number" || !Number.isFinite(condition.valueJson)) {
        return null;
      }
      return {
        field: condition.field,
        operator: condition.operator,
        value: String(condition.valueJson),
        productGid: "",
        productTitle: "",
      };
    }
    case "CART_CONTAINS_PRODUCT": {
      if (condition.operator !== "IN" && condition.operator !== "NOT_IN") return null;
      const gids = condition.valueJson;
      if (!Array.isArray(gids) || gids.length !== 1 || typeof gids[0] !== "string") {
        return null;
      }
      return {
        field: "CART_CONTAINS_PRODUCT",
        operator: condition.operator,
        value: "1",
        productGid: gids[0],
        productTitle: "",
      };
    }
    case "CART_QUANTITY_OF_PRODUCT": {
      if (!NUMERIC_OPS.includes(condition.operator)) return null;
      const value = condition.valueJson;
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const raw = value as { productGid?: unknown; quantity?: unknown };
      if (typeof raw.productGid !== "string" || raw.productGid === "") return null;
      if (typeof raw.quantity !== "number" || !Number.isInteger(raw.quantity)) {
        return null;
      }
      return {
        field: "CART_QUANTITY_OF_PRODUCT",
        operator: condition.operator,
        value: String(raw.quantity),
        productGid: raw.productGid,
        productTitle: "",
      };
    }
    case "CUSTOMER_LOGGED_IN": {
      if (condition.operator !== "EQ" && condition.operator !== "NEQ") return null;
      if (typeof condition.valueJson !== "boolean") return null;
      return {
        field: "CUSTOMER_LOGGED_IN",
        operator: condition.operator,
        value: condition.valueJson ? "true" : "false",
        productGid: "",
        productTitle: "",
      };
    }
    default:
      return null;
  }
}

function availability(shop: { isPlus: boolean }) {
  const support = getExperienceSupport(shop);
  return {
    support,
    options: {
      prePurchaseAvailable: support.PRE_PURCHASE.available && support.PRE_PURCHASE.implemented,
      postPurchaseAvailable:
        support.POST_PURCHASE.available && support.POST_PURCHASE.implemented,
    },
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop, admin, entitlement } = await requireShopContext(request);
  const offerId = params.offerId ?? "";

  const offer = await getRule(shop.id, offerId);
  if (!offer) {
    throw new Response("Offer not found", { status: 404 });
  }

  const conditionRoots = await getConditionTree(shop.id, offerId);
  const flatRoot =
    conditionRoots.length === 1 && (conditionRoots[0].children ?? []).length === 0
      ? conditionRoots[0]
      : null;

  // Advanced trees (nested groups, several roots) and rows the flat editor
  // cannot round-trip stay untouched instead of being rewritten.
  const mappedConditions = flatRoot
    ? flatRoot.conditions.map(toWizardCondition)
    : null;
  const conditionsLocked =
    conditionRoots.length > 0 &&
    (mappedConditions === null || mappedConditions.some((entry) => entry === null));
  const wizardConditions: WizardCondition[] = conditionsLocked
    ? []
    : ((mappedConditions ?? []) as WizardCondition[]);

  const conditionProductGids = wizardConditions
    .map((condition) => condition.productGid)
    .filter((gid) => gid !== "");

  const productGids = [
    ...offer.triggers.map((trigger) => trigger.productGid),
    ...offer.offers.map((item) => item.productGid),
    ...conditionProductGids,
  ];
  await ensureProductSnapshots(admin, shop.id, productGids);
  const [snapshots, offerExperiences] = await Promise.all([
    loadSnapshotViews(shop.id, productGids),
    listOfferExperiences(shop.id, offerId),
  ]);

  for (const condition of wizardConditions) {
    if (condition.productGid) {
      condition.productTitle =
        snapshots.get(condition.productGid)?.title ?? condition.productGid;
    }
  }

  const draft: OfferWizardDraft = {
    name: offer.name,
    description: offer.description ?? "",
    status: statusForWizard(offer.status),
    priority: offer.priority,
    heading: offer.heading ?? "",
    maxOffers: offer.maxOffers === null ? "" : String(offer.maxOffers),
    matchMode: offer.matchMode,
    audience: offer.triggers.length > 0 ? "TRIGGERS" : "ANY_CART",
    showOnProductPage: offer.showOnProductPage,
    showOnCartPage: offer.showOnCartPage,
    sources: offer.sources,
    autoLookbackHours: offer.autoLookbackHours,
    autoMaxOffers: offer.autoMaxOffers === null ? "" : String(offer.autoMaxOffers),
    autoMinRepeats: offer.autoMinRepeats,
    prioritizeRepeats: offer.prioritizeRepeats,
    startsAt: toDateInput(offer.startsAt),
    endsAt: toDateInput(offer.endsAt),
    experiences: toWizardExperiences(offerExperiences),
    triggers: offer.triggers.map((trigger) => {
      const snapshot = snapshots.get(trigger.productGid);
      const variant = snapshot?.variants.find(
        (item) => item.variantGid === trigger.variantGid,
      );
      return {
        productGid: trigger.productGid,
        variantGid: trigger.variantGid,
        title: snapshot?.title ?? trigger.productGid,
        imageUrl: snapshot?.imageUrl ?? null,
        variantTitle: trigger.variantGid
          ? (variant?.title ?? trigger.variantGid)
          : null,
      };
    }),
    offers: offer.offers.map((item) => {
      const snapshot = snapshots.get(item.productGid);
      const variant = snapshot?.variants.find(
        (row) => row.variantGid === item.variantGid,
      );
      return {
        productGid: item.productGid,
        variantGid: item.variantGid,
        title: snapshot?.title ?? item.productGid,
        imageUrl: snapshot?.imageUrl ?? null,
        variantTitle: variant?.title ?? "Variant",
        price: variant?.price ?? null,
        defaultQuantity: item.defaultQuantity,
        minQuantity: item.minQuantity,
        maxQuantity: item.maxQuantity,
      };
    }),
    conditions: wizardConditions,
    conditionJoin: flatRoot?.joinOp ?? "AND",
  };

  return {
    offerId: offer.id,
    offerName: offer.name,
    offerStatus: offer.status,
    draft,
    conditionsLocked,
    maxOffers: entitlement.limits.maxOffersPerRule,
    experienceSupport: getExperienceSupport(shop),
    blockedReason: null,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, admin } = await requireShopContext(request);
  const offerId = params.offerId ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  try {
    if (intent === "delete") {
      await deleteRule(shop.id, offerId);
      return redirect("/app/offers");
    }

    if (intent === "duplicate") {
      const copy = await duplicateRule(shop.id, offerId);
      return redirect(`/app/offers/${copy.id}`);
    }

    const parsed = parseRuleForm(form, availability(shop).options);
    if (!parsed.ok) {
      return { errors: parsed.errors };
    }

    const offer = await updateRule(shop.id, offerId, parsed.input);
    await ensureProductSnapshots(admin, shop.id, [
      ...offer.triggers.map((trigger) => trigger.productGid),
      ...offer.offers.map((item) => item.productGid),
    ]);
    return redirect(`/app/offers/${offer.id}?saved=1`);
  } catch (error) {
    if (error instanceof TenantResourceNotFoundError) {
      throw new Response("Offer not found", { status: 404 });
    }
    if (error instanceof InvalidInputError || error instanceof PlanLimitError) {
      return { errors: { form: error.message } };
    }
    logger.error("Offer update failed", {
      shop: shop.shopDomain,
      offerId,
      intent,
      error: toErrorMessage(error),
    });
    return { errors: { form: "Could not save the offer. Try again." } };
  }
};

export default function EditOffer() {
  const {
    offerId,
    offerName,
    offerStatus,
    draft,
    conditionsLocked,
    maxOffers,
    experienceSupport,
    blockedReason,
  } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (searchParams.get("saved") === "1") {
      shopify.toast.show("Offer saved");
    }
  }, [searchParams, shopify]);

  return (
    <s-stack direction="block" gap="base">
      <OfferWizard
        mode="edit"
        initial={draft}
        errors={data?.errors}
        planMaxOffers={maxOffers}
        experienceSupport={experienceSupport}
        blockedReason={blockedReason}
        conditionsLocked={conditionsLocked}
        cancelHref="/app/offers"
      />

      <s-section heading="Offer actions">
        <s-stack direction="block" gap="base">
          {confirmDelete ? (
            <s-banner tone="critical" heading={`Delete "${offerName}"?`}>
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  The offer and its settings are removed immediately. Analytics already
                  recorded for this offer is kept.
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-button
                    tone="critical"
                    onClick={() =>
                      submit(
                        { intent: "delete" },
                        { method: "post", action: `/app/offers/${offerId}` },
                      )
                    }
                  >
                    Delete offer
                  </s-button>
                  <s-button onClick={() => setConfirmDelete(false)}>Cancel</s-button>
                </s-stack>
              </s-stack>
            </s-banner>
          ) : (
            <s-stack direction="inline" gap="base">
              <s-button
                onClick={() =>
                  submit(
                    { intent: "duplicate" },
                    { method: "post", action: `/app/offers/${offerId}` },
                  )
                }
              >
                Duplicate offer
              </s-button>
              <s-button tone="critical" onClick={() => setConfirmDelete(true)}>
                Delete offer
              </s-button>
            </s-stack>
          )}
          <s-paragraph color="subdued">
            Status: {offerStatus.toLowerCase()} · Offer ID: {offerId}
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-link href="/app/offers">Back to offers</s-link>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
