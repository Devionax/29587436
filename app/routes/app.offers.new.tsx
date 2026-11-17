import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { OfferWizard, emptyWizardDraft } from "../components/offer-wizard";
import { ensureProductSnapshots } from "../services/catalog.server";
import {
  defaultOfferExperiences,
  getExperienceSupport,
  noExperienceReason,
} from "../services/placements.server";
import { createRule } from "../services/rules.server";
import { requireShopContext } from "../services/tenant.server";
import { InvalidInputError, PlanLimitError } from "../utils/errors";
import { toWizardExperiences } from "../utils/experience-view";
import { logger, toErrorMessage } from "../utils/logger.server";
import { parseRuleForm } from "../utils/rule-form.server";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, entitlement } = await requireShopContext(request);
  const { support } = availability(shop);

  return {
    maxOffers: entitlement.limits.maxOffersPerRule,
    experienceSupport: support,
    defaults: toWizardExperiences(defaultOfferExperiences(shop)),
    blockedReason: noExperienceReason(shop),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireShopContext(request);
  const { options } = availability(shop);

  const parsed = parseRuleForm(await request.formData(), options);
  if (!parsed.ok) {
    return { errors: parsed.errors };
  }

  try {
    const offer = await createRule(shop.id, parsed.input);
    await ensureProductSnapshots(admin, shop.id, [
      ...offer.triggers.map((trigger) => trigger.productGid),
      ...offer.offers.map((item) => item.productGid),
    ]);
    return redirect(`/app/offers/${offer.id}?saved=1`);
  } catch (error) {
    if (error instanceof InvalidInputError || error instanceof PlanLimitError) {
      return { errors: { form: error.message } };
    }
    logger.error("Offer creation failed", {
      shop: shop.shopDomain,
      error: toErrorMessage(error),
    });
    return { errors: { form: "Could not save the offer. Try again." } };
  }
};

export default function NewOffer() {
  const data = useActionData<typeof action>();
  const { maxOffers, experienceSupport, defaults, blockedReason } =
    useLoaderData<typeof loader>();

  return (
    <OfferWizard
      mode="create"
      initial={emptyWizardDraft(defaults)}
      errors={data?.errors}
      planMaxOffers={maxOffers}
      experienceSupport={experienceSupport}
      blockedReason={blockedReason}
      cancelHref="/app/offers"
    />
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
