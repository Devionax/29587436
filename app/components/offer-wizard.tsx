import { useState } from "react";
import type { FormEvent } from "react";
import { Form, useNavigation } from "react-router";
import type { ConditionOperator, Experience, OfferSource } from "@prisma/client";
import { ProductPicker } from "./product-picker";
import type { PickerProduct } from "./product-picker";
import { sourceLabel } from "./ui";

/**
 * Eight-step offer workflow.
 *
 * All steps stay mounted inside one form so that values from earlier steps are
 * submitted together; only the visible step changes. Client validation is a
 * convenience — the server parses and validates the same fields again.
 *
 * An offer can be delivered on the product page, the cart page, in checkout, or
 * several at once. Eligibility is either trigger products ("when these are in
 * the cart") or a manual audience ("when any product is in the cart").
 */

export type WizardTrigger = {
  productGid: string;
  variantGid: string;
  title: string;
  imageUrl: string | null;
  variantTitle: string | null;
};

export type WizardProduct = {
  productGid: string;
  variantGid: string;
  title: string;
  imageUrl: string | null;
  variantTitle: string;
  price: string | null;
  defaultQuantity: number;
  minQuantity: number;
  maxQuantity: number;
};

export type WizardStatus = "DRAFT" | "ACTIVE" | "PAUSED";

export type WizardExperience = {
  experience: Experience;
  enabled: boolean;
  headline: string;
  body: string;
  ctaLabel: string;
};

export type WizardExperienceSupport = Record<
  Experience,
  { available: boolean; note: string }
>;

export type WizardAudience = "TRIGGERS" | "ANY_CART";

export type WizardConditionField =
  | "CART_SUBTOTAL"
  | "CART_LINE_COUNT"
  | "CART_TOTAL_QUANTITY"
  | "CART_CONTAINS_PRODUCT"
  | "CART_QUANTITY_OF_PRODUCT"
  | "CUSTOMER_LOGGED_IN";

export type WizardCondition = {
  field: WizardConditionField;
  operator: ConditionOperator;
  /** Numeric input, or "true"/"false" for the sign-in condition. */
  value: string;
  /** Used by the two product conditions. */
  productGid: string;
  productTitle: string;
};

export type OfferWizardDraft = {
  name: string;
  description: string;
  status: WizardStatus;
  priority: number;
  heading: string;
  maxOffers: string;
  matchMode: "ANY" | "ALL";
  audience: WizardAudience;
  showOnProductPage: boolean;
  showOnCartPage: boolean;
  sources: OfferSource[];
  autoLookbackHours: number;
  autoMaxOffers: string;
  autoMinRepeats: number;
  prioritizeRepeats: boolean;
  startsAt: string;
  endsAt: string;
  experiences: WizardExperience[];
  triggers: WizardTrigger[];
  offers: WizardProduct[];
  conditions: WizardCondition[];
  conditionJoin: "AND" | "OR";
};

const STEPS = [
  "Basics",
  "Sources",
  "Products",
  "Automatic rules",
  "Placements",
  "Eligibility",
  "Conditions",
  "Review",
] as const;

const EXPERIENCE_ORDER: Experience[] = ["PRE_PURCHASE", "POST_PURCHASE"];

const EXPERIENCE_LABELS: Record<Experience, string> = {
  PRE_PURCHASE: "Pre-purchase checkout",
  POST_PURCHASE: "Post-purchase page",
};

const SOURCE_OPTIONS: Array<{
  id: OfferSource;
  label: string;
  description: string;
}> = [
  {
    id: "MANUAL",
    label: "Manual selection",
    description: "Pick specific products from your Shopify catalog.",
  },
  {
    id: "RECENTLY_REMOVED",
    label: "Recently removed",
    description:
      "Suggest products this shopper removed from their cart within the lookback window.",
  },
  {
    id: "REPEATED_ACTIVITY",
    label: "Repeated activity",
    description:
      "Suggest products that are repeatedly added to carts across your store.",
  },
];

const STEP_ERROR_KEYS: string[][] = [
  ["name", "description", "heading", "priority", "maxOffers"],
  ["sources"],
  ["offers"],
  ["autoLookbackHours", "autoMaxOffers", "autoMinRepeats"],
  ["experiences", "placements"],
  ["triggers", "matchMode", "startsAt", "endsAt"],
  ["conditions", "conditionJoin"],
  ["form", "status"],
];

const NUMERIC_OPERATORS: ConditionOperator[] = ["EQ", "NEQ", "GT", "GTE", "LT", "LTE"];
const PRODUCT_OPERATORS: ConditionOperator[] = ["IN", "NOT_IN"];
const BOOLEAN_OPERATORS: ConditionOperator[] = ["EQ", "NEQ"];

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  EQ: "equals",
  NEQ: "does not equal",
  GT: "is greater than",
  GTE: "is at least",
  LT: "is less than",
  LTE: "is at most",
  IN: "is",
  NOT_IN: "is not",
};

const CONDITION_FIELDS: Array<{
  id: WizardConditionField;
  label: string;
  description: string;
  operators: ConditionOperator[];
}> = [
  {
    id: "CART_SUBTOTAL",
    label: "Cart subtotal",
    description: "Amount before shipping and taxes, in store currency.",
    operators: NUMERIC_OPERATORS,
  },
  {
    id: "CART_TOTAL_QUANTITY",
    label: "Total items in cart",
    description: "Sum of every line quantity.",
    operators: NUMERIC_OPERATORS,
  },
  {
    id: "CART_LINE_COUNT",
    label: "Distinct products in cart",
    description: "Number of cart lines.",
    operators: NUMERIC_OPERATORS,
  },
  {
    id: "CART_CONTAINS_PRODUCT",
    label: "Cart contains product",
    description: "A specific product is in the cart.",
    operators: PRODUCT_OPERATORS,
  },
  {
    id: "CART_QUANTITY_OF_PRODUCT",
    label: "Quantity of a product",
    description: "Total quantity of one product across all lines.",
    operators: NUMERIC_OPERATORS,
  },
  {
    id: "CUSTOMER_LOGGED_IN",
    label: "Customer signed in",
    description: "Whether the buyer has a customer account session.",
    operators: BOOLEAN_OPERATORS,
  },
];

function conditionMeta(field: WizardConditionField) {
  return CONDITION_FIELDS.find((entry) => entry.id === field) ?? CONDITION_FIELDS[0];
}

function newCondition(field: WizardConditionField): WizardCondition {
  return {
    field,
    operator: conditionMeta(field).operators[0],
    value: field === "CUSTOMER_LOGGED_IN" ? "true" : "1",
    productGid: "",
    productTitle: "",
  };
}

function conditionValue(condition: WizardCondition): unknown {
  switch (condition.field) {
    case "CART_CONTAINS_PRODUCT":
      return condition.productGid ? [condition.productGid] : [];
    case "CART_QUANTITY_OF_PRODUCT":
      return { productGid: condition.productGid, quantity: Number(condition.value) };
    case "CUSTOMER_LOGGED_IN":
      return condition.value === "true";
    default:
      return Number(condition.value);
  }
}

function conditionError(conditions: WizardCondition[]): string | null {
  for (const condition of conditions) {
    const usesProduct =
      condition.field === "CART_CONTAINS_PRODUCT" ||
      condition.field === "CART_QUANTITY_OF_PRODUCT";
    if (usesProduct && !condition.productGid) {
      return "Choose a product for every product condition.";
    }
    if (condition.field === "CUSTOMER_LOGGED_IN") {
      if (condition.value !== "true" && condition.value !== "false") {
        return "Choose signed in or signed out for the sign-in condition.";
      }
      continue;
    }
    if (condition.field !== "CART_CONTAINS_PRODUCT") {
      const value = Number(condition.value);
      if (!Number.isFinite(value) || value < 0) {
        return "Condition amounts must be zero or more.";
      }
      if (condition.field !== "CART_SUBTOTAL" && !Number.isInteger(value)) {
        return "Condition quantities must be whole numbers.";
      }
    }
  }
  return null;
}

function stepForErrors(errors: Record<string, string>): number {
  for (let step = 0; step < STEP_ERROR_KEYS.length; step += 1) {
    if (STEP_ERROR_KEYS[step].some((key) => errors[key])) return step;
  }
  return 0;
}

function clampQuantity(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 100);
}

function validateStep(
  step: number,
  draft: OfferWizardDraft,
  planMaxOffers: number,
  support: WizardExperienceSupport,
): string | null {
  if (step === 0) {
    if (!draft.name.trim()) return "Give this offer a name.";
    if (draft.name.trim().length > 120) return "Keep the name under 120 characters.";
    if (draft.heading.length > 120) return "Keep the buyer-facing heading under 120 characters.";
    if (!Number.isInteger(draft.priority) || draft.priority < 0) {
      return "Priority must be a whole number of 0 or more.";
    }
    return null;
  }

  if (step === 1) {
    if (draft.sources.length === 0) return "Choose at least one recommendation source.";
    return null;
  }

  if (step === 2) {
    if (draft.offers.length > planMaxOffers) {
      return `Your plan allows ${planMaxOffers} products per offer.`;
    }
    if (draft.sources.includes("MANUAL") && draft.offers.length === 0) {
      return "Add at least one product, or remove Manual selection from your sources.";
    }
    return null;
  }

  if (step === 3) {
    if (draft.autoLookbackHours < 1 || draft.autoLookbackHours > 2160) {
      return "Lookback must be from 1 to 2,160 hours.";
    }
    if (draft.autoMinRepeats < 1 || draft.autoMinRepeats > 20) {
      return "Repeats must be from 1 to 20.";
    }
    if (draft.autoMaxOffers !== "") {
      const value = Number(draft.autoMaxOffers);
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        return "Automatic product limit must be from 1 to 10, or left empty.";
      }
    }
    return null;
  }

  if (step === 4) {
    const enabled = draft.experiences.filter((entry) => entry.enabled);
    if (!draft.showOnProductPage && !draft.showOnCartPage && enabled.length === 0) {
      return "Choose at least one placement (product page or cart page) or checkout experience.";
    }
    if (
      enabled.some((entry) => entry.experience === "PRE_PURCHASE") &&
      !support.PRE_PURCHASE.available
    ) {
      return support.PRE_PURCHASE.note;
    }
    return null;
  }

  if (step === 5) {
    if (draft.audience === "TRIGGERS" && draft.triggers.length === 0) {
      return "Add at least one trigger product, or switch to “Any product in the cart”.";
    }
    if (draft.audience === "ANY_CART") {
      if (!draft.sources.includes("MANUAL")) {
        return "Turn on Manual selection so this offer can be sold to any cart.";
      }
      if (draft.offers.length === 0) {
        return "Add at least one product to this offer.";
      }
    }
    if (draft.startsAt && draft.endsAt && draft.endsAt < draft.startsAt) {
      return "The end date must be on or after the start date.";
    }
    return null;
  }

  if (step === 6) {
    return conditionError(draft.conditions);
  }

  return null;
}

export function OfferWizard({
  mode,
  initial,
  errors = {},
  planMaxOffers,
  experienceSupport,
  blockedReason,
  conditionsLocked = false,
  cancelHref,
}: {
  mode: "create" | "edit";
  initial: OfferWizardDraft;
  errors?: Record<string, string>;
  planMaxOffers: number;
  experienceSupport: WizardExperienceSupport;
  /** Non-null when checkout delivery is unavailable; storefront still works. */
  blockedReason: string | null;
  /** True when stored conditions are more advanced than this flat builder. */
  conditionsLocked?: boolean;
  cancelHref: string;
}) {
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const [step, setStep] = useState(() =>
    Object.keys(errors).length > 0 ? stepForErrors(errors) : 0,
  );
  const [furthest, setFurthest] = useState(step);
  const [stepError, setStepError] = useState<string | null>(null);

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [heading, setHeading] = useState(initial.heading);
  const [priority, setPriority] = useState(String(initial.priority));
  const [maxOffers, setMaxOffers] = useState(initial.maxOffers);
  const [status, setStatus] = useState<WizardStatus>(initial.status);

  const [sources, setSources] = useState<OfferSource[]>(initial.sources);
  const [autoLookback, setAutoLookback] = useState(String(initial.autoLookbackHours));
  const [autoMax, setAutoMax] = useState(initial.autoMaxOffers);
  const [autoMinRepeats, setAutoMinRepeats] = useState(String(initial.autoMinRepeats));
  const [prioritizeRepeats, setPrioritizeRepeats] = useState(initial.prioritizeRepeats);

  const [offers, setOffers] = useState<WizardProduct[]>(initial.offers);
  const [triggers, setTriggers] = useState<WizardTrigger[]>(initial.triggers);
  const [matchMode, setMatchMode] = useState<"ANY" | "ALL">(initial.matchMode);
  const [audience, setAudience] = useState<WizardAudience>(initial.audience);
  const [showOnProductPage, setShowOnProductPage] = useState(initial.showOnProductPage);
  const [showOnCartPage, setShowOnCartPage] = useState(initial.showOnCartPage);
  const [startsAt, setStartsAt] = useState(initial.startsAt);
  const [endsAt, setEndsAt] = useState(initial.endsAt);
  const [conditions, setConditions] = useState<WizardCondition[]>(initial.conditions);
  const [conditionJoin, setConditionJoin] = useState<"AND" | "OR">(initial.conditionJoin);

  const [experiences, setExperiences] = useState<WizardExperience[]>(() =>
    initial.experiences.map((entry) =>
      entry.experience === "PRE_PURCHASE" &&
      !experienceSupport.PRE_PURCHASE.available
        ? { ...entry, enabled: false }
        : entry,
    ),
  );
  // Pre-purchase is limited by the store's plan, so it is disabled in the form.
  // Post-purchase is limited by the deployment: the enabled choice is kept and
  // delivery starts once POST_PURCHASE_ENABLED is on.
  const planBlockedExperiences = initial.experiences.filter(
    (entry) => entry.enabled && entry.experience === "PRE_PURCHASE" && !experienceSupport.PRE_PURCHASE.available,
  );
  const deploymentBlockedExperiences = initial.experiences.filter(
    (entry) => entry.enabled && !experienceSupport[entry.experience].available && entry.experience !== "PRE_PURCHASE",
  );

  const updateExperience = (experience: Experience, patch: Partial<WizardExperience>) => {
    setExperiences((current) =>
      current.map((entry) =>
        entry.experience === experience ? { ...entry, ...patch } : entry,
      ),
    );
  };

  const hasAutomatic = sources.some((source) => source !== "MANUAL");
  const usesManual = sources.includes("MANUAL");

  const draft: OfferWizardDraft = {
    name,
    description,
    status,
    priority: Number.isInteger(Number(priority)) ? Number(priority) : 100,
    heading,
    maxOffers,
    matchMode,
    audience,
    showOnProductPage,
    showOnCartPage,
    sources,
    autoLookbackHours: Number(autoLookback) || 168,
    autoMaxOffers: autoMax,
    autoMinRepeats: Number(autoMinRepeats) || 2,
    prioritizeRepeats,
    startsAt,
    endsAt,
    experiences,
    triggers,
    offers,
    conditions,
    conditionJoin,
  };

  const toggleSource = (source: OfferSource, checked: boolean) => {
    setSources((current) =>
      checked
        ? current.includes(source)
          ? current
          : [...current, source]
        : current.filter((item) => item !== source),
    );
  };

  const moveSource = (index: number, direction: -1 | 1) => {
    setSources((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const addOffer = (product: PickerProduct, variantGid: string) => {
    const variant = product.variants.find((item) => item.variantGid === variantGid);
    if (!variant) return;
    if (offers.some((offer) => offer.productGid === product.productGid)) return;
    if (offers.some((offer) => offer.variantGid === variantGid)) return;
    if (offers.length >= planMaxOffers) return;

    setOffers((current) => [
      ...current,
      {
        productGid: product.productGid,
        variantGid,
        title: product.title,
        imageUrl: product.imageUrl,
        variantTitle: variant.title,
        price: variant.price,
        defaultQuantity: 1,
        minQuantity: 1,
        maxQuantity: 10,
      },
    ]);
  };

  const addTrigger = (product: PickerProduct, variantGid: string) => {
    if (
      triggers.some(
        (trigger) =>
          trigger.productGid === product.productGid &&
          trigger.variantGid === variantGid,
      )
    ) {
      return;
    }
    const variant = product.variants.find((item) => item.variantGid === variantGid) ?? null;
    setTriggers((current) => [
      ...current,
      {
        productGid: product.productGid,
        variantGid,
        title: product.title,
        imageUrl: product.imageUrl,
        variantTitle: variant ? variant.title : null,
      },
    ]);
  };

  const updateOffer = (variantGid: string, patch: Partial<WizardProduct>) => {
    setOffers((current) =>
      current.map((offer) =>
        offer.variantGid === variantGid ? { ...offer, ...patch } : offer,
      ),
    );
  };

  const updateCondition = (index: number, patch: Partial<WizardCondition>) => {
    setConditions((current) =>
      current.map((condition, position) =>
        position === index ? { ...condition, ...patch } : condition,
      ),
    );
  };

  const goNext = () => {
    const error = validateStep(step, draft, planMaxOffers, experienceSupport);
    if (error) {
      setStepError(error);
      return;
    }
    setStepError(null);
    const next = Math.min(step + 1, STEPS.length - 1);
    setStep(next);
    setFurthest((current) => Math.max(current, next));
  };

  const goBack = () => {
    setStepError(null);
    setStep((current) => Math.max(current - 1, 0));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    for (let index = 0; index < STEPS.length - 1; index += 1) {
      const error = validateStep(index, draft, planMaxOffers, experienceSupport);
      if (error) {
        event.preventDefault();
        setStep(index);
        setStepError(error);
        return;
      }
    }
    setStepError(null);
  };

  const serverErrors = Object.entries(errors).filter(([, message]) => Boolean(message));

  return (
    <Form method="post" onSubmit={submit}>
      <input type="hidden" name="sources" value={JSON.stringify(sources)} />
      <input
        type="hidden"
        name="triggers"
        value={JSON.stringify(audience === "TRIGGERS" ? triggers : [])}
      />
      <input type="hidden" name="offers" value={JSON.stringify(offers)} />
      <input type="hidden" name="experiences" value={JSON.stringify(experiences)} />
      {showOnProductPage && <input type="hidden" name="showOnProductPage" value="on" />}
      {showOnCartPage && <input type="hidden" name="showOnCartPage" value="on" />}
      <input
        type="hidden"
        name="conditions"
        value={JSON.stringify(
          conditions.map((condition) => ({
            field: condition.field,
            operator: condition.operator,
            value: conditionValue(condition),
          })),
        )}
      />
      <input type="hidden" name="conditionJoin" value={conditionJoin} />
      {conditionsLocked && <input type="hidden" name="conditionsLocked" value="1" />}
      {prioritizeRepeats && <input type="hidden" name="prioritizeRepeats" value="on" />}

      <s-page heading={mode === "create" ? "Create offer" : "Edit offer"}>
        <s-stack direction="block" gap="base">
          {blockedReason && (
            <s-banner tone="info" heading="Checkout delivery is unavailable for this store">
              <s-paragraph>
                {blockedReason} Product page and cart page placements still work, so an
                offer can be saved and shown on the storefront without checkout.
              </s-paragraph>
            </s-banner>
          )}
          <s-box padding="base" background="subdued" borderRadius="large-100">
            <s-stack direction="inline" gap="small">
              {STEPS.map((label, index) => (
                <s-button
                  key={label}
                  variant={index === step ? "primary" : "tertiary"}
                  disabled={index > furthest}
                  onClick={() => {
                    setStepError(null);
                    setStep(index);
                  }}
                >
                  {index + 1}. {label}
                </s-button>
              ))}
            </s-stack>
          </s-box>

          {serverErrors.length > 0 && (
            <s-banner tone="critical" heading="Offer not saved">
              <s-unordered-list>
                {serverErrors.map(([key, message]) => (
                  <s-list-item key={key}>{message}</s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          )}

          {stepError && (
            <s-banner tone="warning" heading="Check this step">
              <s-paragraph>{stepError}</s-paragraph>
            </s-banner>
          )}

          <div hidden={step !== 0}>
            <s-section heading="Basics">
              <s-stack direction="block" gap="base">
                <s-text-field
                  label="Offer name"
                  name="name"
                  value={name}
                  required
                  details="Internal name; buyers never see it."
                  onInput={(event) => setName(event.currentTarget.value)}
                />
                <s-text-area
                  label="Internal note"
                  name="description"
                  value={description}
                  rows={2}
                  onInput={(event) => setDescription(event.currentTarget.value)}
                />
                <s-text-field
                  label="Heading shown to buyers"
                  name="heading"
                  value={heading}
                  placeholder="Pairs well with"
                  details="Leave empty to use the storefront default heading."
                  onInput={(event) => setHeading(event.currentTarget.value)}
                />
                <s-stack direction="inline" gap="base">
                  <s-number-field
                    label="Priority"
                    name="priority"
                    value={priority}
                    min={0}
                    details="Lower numbers are evaluated first."
                    onChange={(event) => setPriority(event.currentTarget.value)}
                  />
                  <s-number-field
                    label="Max products in this offer"
                    name="maxOffers"
                    value={maxOffers}
                    min={1}
                    max={10}
                    details="Optional; capped by the storefront limit."
                    onChange={(event) => setMaxOffers(event.currentTarget.value)}
                  />
                </s-stack>
              </s-stack>
            </s-section>
          </div>

          <div hidden={step !== 1}>
            <s-section heading="Recommendation sources">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Combine sources freely. When several sources produce candidates, the
                  first source in this list wins and each product appears once.
                </s-paragraph>

                {SOURCE_OPTIONS.map((option) => (
                  <s-box
                    key={option.id}
                    padding="base"
                    border="base"
                    borderRadius="large-100"
                  >
                    <s-stack direction="block" gap="small">
                      <s-checkbox
                        label={option.label}
                        checked={sources.includes(option.id)}
                        onChange={(event) =>
                          toggleSource(option.id, event.currentTarget.checked)
                        }
                      />
                      <s-paragraph color="subdued">{option.description}</s-paragraph>
                    </s-stack>
                  </s-box>
                ))}

                {sources.length > 1 && (
                  <s-section heading="Source priority">
                    <s-stack direction="block" gap="small">
                      {sources.map((source, index) => (
                        <s-stack key={source} direction="inline" gap="base" alignItems="center">
                          <s-badge tone="neutral">{index + 1}</s-badge>
                          <s-text>{sourceLabel(source)}</s-text>
                          <s-button
                            variant="tertiary"
                            disabled={index === 0}
                            onClick={() => moveSource(index, -1)}
                          >
                            Move up
                          </s-button>
                          <s-button
                            variant="tertiary"
                            disabled={index === sources.length - 1}
                            onClick={() => moveSource(index, 1)}
                          >
                            Move down
                          </s-button>
                        </s-stack>
                      ))}
                    </s-stack>
                  </s-section>
                )}
              </s-stack>
            </s-section>
          </div>

          <div hidden={step !== 2}>
            <s-section heading="Manual product selection">
              <s-stack direction="block" gap="base">
                {!usesManual && (
                  <s-banner tone="info" heading="Manual source is off">
                    <s-paragraph>
                      Add Manual selection on the previous step to hand-pick products.
                      Automatic sources will fill the offer.
                    </s-paragraph>
                  </s-banner>
                )}

                {usesManual && (
                  <>
                    <s-paragraph>
                      {offers.length} of {planMaxOffers} products used on this plan.
                      Each product can appear only once.
                    </s-paragraph>

                    {offers.length === 0 && (
                      <s-paragraph color="subdued">
                        No products selected yet. Search your Shopify catalog below.
                      </s-paragraph>
                    )}

                    {offers.map((offer) => (
                      <s-box
                        key={offer.variantGid}
                        padding="base"
                        border="base"
                        borderRadius="large-100"
                      >
                        <s-stack direction="block" gap="small">
                          <s-stack direction="inline" gap="base" alignItems="center">
                            {offer.imageUrl ? (
                              <s-thumbnail
                                src={offer.imageUrl}
                                alt={offer.title}
                                size="small"
                              />
                            ) : null}
                            <s-stack direction="block" gap="none">
                              <s-text type="strong">{offer.title}</s-text>
                              <s-text color="subdued">
                                {offer.variantTitle}
                                {offer.price ? ` · ${offer.price}` : ""}
                              </s-text>
                            </s-stack>
                            <s-button
                              variant="tertiary"
                              tone="critical"
                              onClick={() =>
                                setOffers((current) =>
                                  current.filter(
                                    (item) => item.variantGid !== offer.variantGid,
                                  ),
                                )
                              }
                            >
                              Remove
                            </s-button>
                          </s-stack>
                          <s-stack direction="inline" gap="base">
                            <s-number-field
                              label="Min quantity"
                              value={String(offer.minQuantity)}
                              min={1}
                              max={100}
                              onChange={(event) =>
                                updateOffer(offer.variantGid, {
                                  minQuantity: clampQuantity(
                                    event.currentTarget.value,
                                    offer.minQuantity,
                                  ),
                                })
                              }
                            />
                            <s-number-field
                              label="Default quantity"
                              value={String(offer.defaultQuantity)}
                              min={1}
                              max={100}
                              onChange={(event) =>
                                updateOffer(offer.variantGid, {
                                  defaultQuantity: clampQuantity(
                                    event.currentTarget.value,
                                    offer.defaultQuantity,
                                  ),
                                })
                              }
                            />
                            <s-number-field
                              label="Max quantity"
                              value={String(offer.maxQuantity)}
                              min={1}
                              max={100}
                              onChange={(event) =>
                                updateOffer(offer.variantGid, {
                                  maxQuantity: clampQuantity(
                                    event.currentTarget.value,
                                    offer.maxQuantity,
                                  ),
                                })
                              }
                            />
                          </s-stack>
                        </s-stack>
                      </s-box>
                    ))}

                    {offers.length < planMaxOffers ? (
                      <ProductPicker
                        label="Add a product to this offer"
                        excludeProductGids={offers.map((offer) => offer.productGid)}
                        excludeVariantGids={offers.map((offer) => offer.variantGid)}
                        onPick={addOffer}
                      />
                    ) : (
                      <s-paragraph>
                        Product limit reached for this plan.{" "}
                        <s-link href="/app/billing">Review plans</s-link> to add more.
                      </s-paragraph>
                    )}
                  </>
                )}
              </s-stack>
            </s-section>
          </div>

          <div hidden={step !== 3}>
            <s-section heading="Automatic settings">
              <s-stack direction="block" gap="base">
                {!hasAutomatic && (
                  <s-banner tone="info" heading="Automatic sources are off">
                    <s-paragraph>
                      Enable Recently removed or Repeated activity on the Sources step
                      to generate products from cart activity. These settings are saved
                      either way.
                    </s-paragraph>
                  </s-banner>
                )}
                <s-paragraph>
                  Activity comes from Shopify cart webhooks for this store. Custom
                  storefront carts that do not send Shopify cart webhooks are not
                  included, so automatic sources may stay empty on headless setups.
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-number-field
                    label="Lookback window (hours)"
                    name="autoLookbackHours"
                    value={autoLookback}
                    min={1}
                    max={2160}
                    details="How far back cart activity is considered."
                    onChange={(event) => setAutoLookback(event.currentTarget.value)}
                  />
                  <s-number-field
                    label="Minimum repeats"
                    name="autoMinRepeats"
                    value={autoMinRepeats}
                    min={1}
                    max={20}
                    details="Adds required before Repeated activity suggests a product."
                    onChange={(event) => setAutoMinRepeats(event.currentTarget.value)}
                  />
                  <s-number-field
                    label="Max automatic products"
                    name="autoMaxOffers"
                    value={autoMax}
                    min={1}
                    max={10}
                    details="Optional; defaults to the storefront limit."
                    onChange={(event) => setAutoMax(event.currentTarget.value)}
                  />
                </s-stack>
                <s-checkbox
                  label="Prioritize products that keep coming back"
                  checked={prioritizeRepeats}
                  onChange={(event) =>
                    setPrioritizeRepeats(event.currentTarget.checked)
                  }
                />
              </s-stack>
            </s-section>
          </div>

          <div hidden={step !== 4}>
            <s-section heading="Placements">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Choose where this offer may appear. Storefront placements work on
                  every Shopify plan; checkout experiences below are limited by this
                  store&apos;s plan and app approvals.
                </s-paragraph>

                <s-box padding="base" border="base" borderRadius="large-100">
                  <s-stack direction="block" gap="small">
                    <s-checkbox
                      label="Product page"
                      checked={showOnProductPage}
                      onChange={(event) =>
                        setShowOnProductPage(event.currentTarget.checked)
                      }
                    />
                    <s-paragraph color="subdued">
                      Shown by the theme app extension block on product pages whose
                      product matches this offer.
                    </s-paragraph>
                  </s-stack>
                </s-box>

                <s-box padding="base" border="base" borderRadius="large-100">
                  <s-stack direction="block" gap="small">
                    <s-checkbox
                      label="Cart page"
                      checked={showOnCartPage}
                      onChange={(event) =>
                        setShowOnCartPage(event.currentTarget.checked)
                      }
                    />
                    <s-paragraph color="subdued">
                      Shown by the theme app extension block on the cart page and kept in
                      sync as the cart changes.
                    </s-paragraph>
                  </s-stack>
                </s-box>

                <s-divider />
                <s-text type="strong">Checkout experiences</s-text>
                <s-paragraph color="subdued">
                  Optional. Pre-purchase requires Shopify Plus. Post-purchase is saved
                  here and starts delivering when this deployment enables it.
                </s-paragraph>

                {planBlockedExperiences.length > 0 && (
                  <s-banner tone="warning" heading="An experience is not available on this plan">
                    <s-paragraph>
                      {planBlockedExperiences
                        .map((entry) => EXPERIENCE_LABELS[entry.experience])
                        .join(", ")}{" "}
                      was enabled earlier but this store cannot use it right now. Saving
                      will turn it off for this offer; its copy is kept.
                    </s-paragraph>
                  </s-banner>
                )}

                {deploymentBlockedExperiences.length > 0 && (
                  <s-banner tone="info" heading="An experience is waiting on the deployment">
                    <s-paragraph>
                      {deploymentBlockedExperiences
                        .map((entry) => EXPERIENCE_LABELS[entry.experience])
                        .join(", ")}{" "}
                      is enabled on this offer but this deployment cannot deliver it
                      yet. The setting is kept and starts delivering once the deployment
                      enables post-purchase access.
                    </s-paragraph>
                  </s-banner>
                )}

                {EXPERIENCE_ORDER.map((experience) => {
                  const entry = experiences.find(
                    (item) => item.experience === experience,
                  ) ?? {
                    experience,
                    enabled: false,
                    headline: "",
                    body: "",
                    ctaLabel: "",
                  };
                  const support = experienceSupport[experience];

                  return (
                    <s-box
                      key={experience}
                      padding="base"
                      border="base"
                      borderRadius="large-100"
                    >
                      <s-stack direction="block" gap="small">
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-checkbox
                            label={EXPERIENCE_LABELS[experience]}
                            checked={entry.enabled}
                            disabled={
                              experience === "PRE_PURCHASE" && !support.available
                            }
                            onChange={(event) =>
                              updateExperience(experience, {
                                enabled: event.currentTarget.checked,
                              })
                            }
                          />
                          <s-badge tone={support.available ? "info" : "neutral"}>
                            {support.available ? "Available" : "Unavailable"}
                          </s-badge>
                        </s-stack>
                        <s-text color="subdued">{support.note}</s-text>

                        {entry.enabled && (
                          <>
                            <s-text-field
                              label="Headline"
                              value={entry.headline}
                              details="Optional. Falls back to the offer heading."
                              onInput={(event) =>
                                updateExperience(experience, {
                                  headline: event.currentTarget.value,
                                })
                              }
                            />
                            <s-text-area
                              label="Body copy"
                              value={entry.body}
                              rows={2}
                              details="Optional. A short reason to add the product."
                              onInput={(event) =>
                                updateExperience(experience, {
                                  body: event.currentTarget.value,
                                })
                              }
                            />
                            <s-text-field
                              label="Call to action"
                              value={entry.ctaLabel}
                              details="Optional. Falls back to a default add button label for the experience."
                              onInput={(event) =>
                                updateExperience(experience, {
                                  ctaLabel: event.currentTarget.value,
                                })
                              }
                            />
                          </>
                        )}
                      </s-stack>
                    </s-box>
                  );
                })}
              </s-stack>
            </s-section>
          </div>

          <div hidden={step !== 5}>
            <s-section heading="Eligibility">
              <s-stack direction="block" gap="base">
                <s-select
                  label="When should this offer be eligible?"
                  value={audience}
                  onChange={(event) =>
                    setAudience(event.currentTarget.value as WizardAudience)
                  }
                >
                  <s-option value="ANY_CART">
                    Any product in the cart — no trigger products needed
                  </s-option>
                  <s-option value="TRIGGERS">
                    Specific trigger products in the cart
                  </s-option>
                </s-select>

                {audience === "ANY_CART" && (
                  <s-box padding="base" background="subdued" borderRadius="large-100">
                    <s-stack direction="block" gap="small">
                      <s-text type="strong">Unconditional offer</s-text>
                      <s-paragraph color="subdued">
                        Eligible whenever the cart holds at least one item. It is hidden
                        while the cart is empty and returns as soon as another item is
                        added. The storefront re-evaluates on every cart change.
                      </s-paragraph>
                      {!sources.includes("MANUAL") && (
                        <s-banner tone="warning" heading="Manual selection is off">
                          <s-paragraph>
                            Turn on Manual selection on the Sources step so these products
                            are the ones offered.
                          </s-paragraph>
                        </s-banner>
                      )}
                    </s-stack>
                  </s-box>
                )}

                {audience === "TRIGGERS" && (
                  <>
                    <s-paragraph color="subdued">
                      A variant trigger matches only that variant; a product trigger
                      matches any variant.
                    </s-paragraph>
                    <s-select
                      label="Match mode"
                      name="matchMode"
                      value={matchMode}
                      onChange={(event) =>
                        setMatchMode(event.currentTarget.value as "ANY" | "ALL")
                      }
                    >
                      <s-option value="ANY">Any trigger product in the cart</s-option>
                      <s-option value="ALL">All trigger products in the cart</s-option>
                    </s-select>

                {triggers.length === 0 && (
                  <s-paragraph color="subdued">No trigger products yet.</s-paragraph>
                )}

                {triggers.map((trigger) => (
                  <s-stack
                    key={`${trigger.productGid}|${trigger.variantGid}`}
                    direction="inline"
                    gap="base"
                    alignItems="center"
                  >
                    {trigger.imageUrl ? (
                      <s-thumbnail src={trigger.imageUrl} alt={trigger.title} size="small" />
                    ) : null}
                    <s-text>
                      {trigger.title}
                      {trigger.variantTitle
                        ? ` — ${trigger.variantTitle}`
                        : " — any variant"}
                    </s-text>
                    <s-button
                      variant="tertiary"
                      onClick={() =>
                        setTriggers((current) =>
                          current.filter(
                            (item) =>
                              !(
                                item.productGid === trigger.productGid &&
                                item.variantGid === trigger.variantGid
                              ),
                          ),
                        )
                      }
                    >
                      Remove
                    </s-button>
                  </s-stack>
                ))}

                <ProductPicker
                  label="Add a trigger product"
                  allowAnyVariant
                  excludeVariantGids={triggers
                    .filter((trigger) => trigger.variantGid)
                    .map((trigger) => trigger.variantGid)}
                  onPick={addTrigger}
                />
                  </>
                )}

                <s-divider />
                <s-paragraph>
                  Scheduling is optional. Start is inclusive from 00:00 UTC; the end
                  date is inclusive through the end of that day.
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-date-field
                    label="Starts on"
                    name="startsAt"
                    value={startsAt}
                    onChange={(event) => setStartsAt(event.currentTarget.value)}
                  />
                  <s-date-field
                    label="Ends on"
                    name="endsAt"
                    value={endsAt}
                    onChange={(event) => setEndsAt(event.currentTarget.value)}
                  />
                </s-stack>
              </s-stack>
            </s-section>
          </div>

          <div hidden={step !== 6}>
            <s-section heading="Conditions">
              <s-stack direction="block" gap="base">
                {conditionsLocked ? (
                  <s-banner tone="info" heading="Advanced conditions are kept as they are">
                    <s-paragraph>
                      This offer has condition groups created outside this form. Saving
                      here will not change them.
                    </s-paragraph>
                  </s-banner>
                ) : (
                  <>
                    <s-paragraph>
                      Optional. The offer is eligible only when these conditions pass, in
                      addition to the eligibility rule. Leave empty to ignore cart totals
                      and contents.
                    </s-paragraph>

                    {conditions.length === 0 && (
                      <s-paragraph color="subdued">No conditions yet.</s-paragraph>
                    )}

                    {conditions.length > 1 && (
                      <s-select
                        label="Combine conditions with"
                        value={conditionJoin}
                        onChange={(event) =>
                          setConditionJoin(event.currentTarget.value as "AND" | "OR")
                        }
                      >
                        <s-option value="AND">All conditions must be true (AND)</s-option>
                        <s-option value="OR">Any condition is enough (OR)</s-option>
                      </s-select>
                    )}

                    {conditions.map((condition, index) => {
                      const meta = conditionMeta(condition.field);
                      const usesProduct =
                        condition.field === "CART_CONTAINS_PRODUCT" ||
                        condition.field === "CART_QUANTITY_OF_PRODUCT";

                      return (
                        <s-box
                          key={`${condition.field}-${index}`}
                          padding="base"
                          border="base"
                          borderRadius="large-100"
                        >
                          <s-stack direction="block" gap="small">
                            <s-stack direction="inline" gap="base" alignItems="center">
                              <s-text type="strong">{meta.label}</s-text>
                              <s-button
                                variant="tertiary"
                                tone="critical"
                                onClick={() =>
                                  setConditions((current) =>
                                    current.filter((_, position) => position !== index),
                                  )
                                }
                              >
                                Remove
                              </s-button>
                            </s-stack>
                            <s-text color="subdued">{meta.description}</s-text>

                            <s-stack direction="inline" gap="base">
                              <s-select
                                label="Operator"
                                value={condition.operator}
                                onChange={(event) =>
                                  updateCondition(index, {
                                    operator: event.currentTarget
                                      .value as ConditionOperator,
                                  })
                                }
                              >
                                {meta.operators.map((operator) => (
                                  <s-option key={operator} value={operator}>
                                    {OPERATOR_LABELS[operator]}
                                  </s-option>
                                ))}
                              </s-select>

                              {condition.field === "CUSTOMER_LOGGED_IN" ? (
                                <s-select
                                  label="Value"
                                  value={condition.value}
                                  onChange={(event) =>
                                    updateCondition(index, {
                                      value: event.currentTarget.value,
                                    })
                                  }
                                >
                                  <s-option value="true">Signed in</s-option>
                                  <s-option value="false">Signed out</s-option>
                                </s-select>
                              ) : condition.field === "CART_CONTAINS_PRODUCT" ? null : (
                                <s-number-field
                                  label={
                                    condition.field === "CART_SUBTOTAL"
                                      ? "Amount"
                                      : "Quantity"
                                  }
                                  value={condition.value}
                                  min={0}
                                  step={condition.field === "CART_SUBTOTAL" ? 0.01 : 1}
                                  onChange={(event) =>
                                    updateCondition(index, {
                                      value: event.currentTarget.value,
                                    })
                                  }
                                />
                              )}
                            </s-stack>

                            {usesProduct &&
                              (condition.productGid ? (
                                <s-stack
                                  direction="inline"
                                  gap="base"
                                  alignItems="center"
                                >
                                  <s-text>
                                    {condition.productTitle || condition.productGid}
                                  </s-text>
                                  <s-button
                                    variant="tertiary"
                                    onClick={() =>
                                      updateCondition(index, {
                                        productGid: "",
                                        productTitle: "",
                                      })
                                    }
                                  >
                                    Change
                                  </s-button>
                                </s-stack>
                              ) : (
                                <ProductPicker
                                  label="Choose a product"
                                  allowAnyVariant
                                  onPick={(product) =>
                                    updateCondition(index, {
                                      productGid: product.productGid,
                                      productTitle: product.title,
                                    })
                                  }
                                />
                              ))}
                          </s-stack>
                        </s-box>
                      );
                    })}

                    <s-stack direction="inline" gap="small">
                      {CONDITION_FIELDS.map((entry) => (
                        <s-button
                          key={entry.id}
                          variant="tertiary"
                          onClick={() =>
                            setConditions((current) => [
                              ...current,
                              newCondition(entry.id),
                            ])
                          }
                        >
                          + {entry.label}
                        </s-button>
                      ))}
                    </s-stack>
                  </>
                )}
              </s-stack>
            </s-section>
          </div>

          <div hidden={step !== 7}>
            <s-section heading="Review and activate">
              <s-stack direction="block" gap="base">
                <s-unordered-list>
                  <s-list-item>
                    <s-text type="strong">Name:</s-text> {name || "Not set"}
                  </s-list-item>
                  <s-list-item>
                    <s-text type="strong">Sources:</s-text>{" "}
                    {sources.length > 0
                      ? sources.map(sourceLabel).join(" → ")
                      : "None selected"}
                  </s-list-item>
                  <s-list-item>
                    <s-text type="strong">Manual products:</s-text> {offers.length}
                  </s-list-item>
                  <s-list-item>
                    <s-text type="strong">Automatic:</s-text>{" "}
                    {hasAutomatic
                      ? `${autoLookback || "168"}h lookback, at least ${
                          autoMinRepeats || "2"
                        } repeat(s)`
                      : "Off"}
                  </s-list-item>
                  <s-list-item>
                    <s-text type="strong">Placements:</s-text>{" "}
                    {[
                      showOnProductPage ? "Product page" : null,
                      showOnCartPage ? "Cart page" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "None"}
                  </s-list-item>
                  <s-list-item>
                    <s-text type="strong">Checkout experiences:</s-text>{" "}
                    {experiences
                      .filter((entry) => entry.enabled)
                      .map((entry) => EXPERIENCE_LABELS[entry.experience])
                      .join(" · ") || "None"}
                  </s-list-item>
                  <s-list-item>
                    <s-text type="strong">Eligibility:</s-text>{" "}
                    {audience === "ANY_CART"
                      ? "Any product in the cart"
                      : `${triggers.length} trigger product${
                          triggers.length === 1 ? "" : "s"
                        } (${matchMode === "ANY" ? "any" : "all"} must match)`}
                  </s-list-item>
                  <s-list-item>
                    <s-text type="strong">Conditions:</s-text>{" "}
                    {conditionsLocked
                      ? "Advanced conditions (kept as stored)"
                      : conditions.length === 0
                        ? "None"
                        : `${conditions.length} condition${
                            conditions.length === 1 ? "" : "s"
                          } joined with ${conditionJoin}`}
                  </s-list-item>
                  <s-list-item>
                    <s-text type="strong">Schedule:</s-text>{" "}
                    {startsAt || endsAt
                      ? `${startsAt || "no start"} to ${endsAt || "no end"}`
                      : "Always on while active"}
                  </s-list-item>
                </s-unordered-list>

                <s-select
                  label="Status after saving"
                  name="status"
                  value={status}
                  onChange={(event) =>
                    setStatus(event.currentTarget.value as WizardStatus)
                  }
                >
                  <s-option value="ACTIVE">Active — show on the storefront</s-option>
                  <s-option value="DRAFT">Draft — not shown yet</s-option>
                  <s-option value="PAUSED">Paused — keep settings, hide offers</s-option>
                </s-select>

                <s-paragraph color="subdued">
                  Activating counts toward your plan&apos;s active offer limit. The server
                  checks the limit again before saving.
                </s-paragraph>

                <s-stack direction="inline" gap="base">
                  <s-button type="submit" variant="primary" {...(saving ? { loading: true } : {})}>
                    {mode === "create" ? "Create offer" : "Save offer"}
                  </s-button>
                  <s-link href={cancelHref}>Cancel</s-link>
                </s-stack>
              </s-stack>
            </s-section>
          </div>

          <s-stack direction="inline" gap="base">
            <s-button disabled={step === 0} onClick={goBack}>
              Back
            </s-button>
            {step < STEPS.length - 1 && (
              <s-button variant="primary" onClick={goNext}>
                Next
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-page>
    </Form>
  );
}

/** Maps a persisted rule to wizard defaults for the create and edit pages. */
export function emptyWizardDraft(
  experiences: WizardExperience[],
): OfferWizardDraft {
  return {
    name: "",
    description: "",
    status: "ACTIVE",
    priority: 100,
    heading: "",
    maxOffers: "",
    matchMode: "ANY",
    // A new offer starts as a manual (any-cart) offer with storefront
    // placements on; trigger products are opt-in on the Eligibility step.
    audience: "ANY_CART",
    showOnProductPage: true,
    showOnCartPage: true,
    sources: ["MANUAL"],
    autoLookbackHours: 168,
    autoMaxOffers: "",
    autoMinRepeats: 2,
    prioritizeRepeats: true,
    startsAt: "",
    endsAt: "",
    experiences,
    triggers: [],
    offers: [],
    conditions: [],
    conditionJoin: "AND",
  };
}

export function toDateInput(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

export function statusForWizard(status: string): WizardStatus {
  return status === "ACTIVE" || status === "PAUSED" ? status : "DRAFT";
}
