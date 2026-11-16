import { useState } from "react";
import { Form, useFetcher, useNavigation } from "react-router";

/**
 * Shared rule editor used by the create and edit pages.
 *
 * Triggers and offers are kept in React state and submitted as one JSON field;
 * the server re-validates every value (see utils/rule-form.server.ts). Only
 * GIDs, titles and quantity settings are sent — no prices or availability.
 */

export type PickerVariant = {
  variantGid: string;
  title: string;
  price: string;
  availableForSale: boolean;
};

export type PickerProduct = {
  productGid: string;
  title: string;
  imageUrl: string | null;
  variants: PickerVariant[];
};

export type TriggerDraft = {
  productGid: string;
  variantGid: string;
  title: string;
  imageUrl: string | null;
  variantTitle: string | null;
};

export type OfferDraft = {
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

export type RuleDraft = {
  name: string;
  description: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED";
  priority: number;
  matchMode: "ANY" | "ALL";
  heading: string;
  maxOffers: string;
  showOnProductPage: boolean;
  showOnCartPage: boolean;
  triggers: TriggerDraft[];
  offers: OfferDraft[];
};

type PickerResponse = {
  products?: PickerProduct[];
  error?: string;
};

function ProductSearch({
  label,
  allowAnyVariant,
  onPick,
}: {
  label: string;
  allowAnyVariant: boolean;
  onPick: (product: PickerProduct, variantGid: string) => void;
}) {
  const fetcher = useFetcher<PickerResponse>();
  const [search, setSearch] = useState("");
  const [variantChoice, setVariantChoice] = useState<Record<string, string>>({});

  const runSearch = () => {
    fetcher.load(`/app/api/products?q=${encodeURIComponent(search.trim())}`);
  };

  const results = fetcher.data?.products ?? [];
  const loading = fetcher.state !== "idle";

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="base">
        <s-text-field
          label={label}
          labelAccessibilityVisibility="exclusive"
          placeholder="Product title, tag, or SKU"
          value={search}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
        <s-button onClick={runSearch} {...(loading ? { loading: true } : {})}>
          Search
        </s-button>
      </s-stack>

      {fetcher.data?.error && (
        <s-banner tone="critical" heading="Search failed">
          <s-paragraph>{fetcher.data.error}</s-paragraph>
        </s-banner>
      )}

      {!loading && fetcher.data && results.length === 0 && !fetcher.data.error && (
        <s-paragraph>No products matched that search.</s-paragraph>
      )}

      {results.map((product) => {
        const choice =
          variantChoice[product.productGid] ??
          (allowAnyVariant ? "" : (product.variants[0]?.variantGid ?? ""));

        return (
          <s-stack key={product.productGid} direction="inline" gap="base">
            {product.imageUrl ? (
              <s-thumbnail src={product.imageUrl} alt={product.title} size="small" />
            ) : null}
            <s-text>{product.title}</s-text>
            <s-select
              label="Variant"
              labelAccessibilityVisibility="exclusive"
              value={choice}
              onChange={(event) =>
                setVariantChoice((current) => ({
                  ...current,
                  [product.productGid]: event.currentTarget.value,
                }))
              }
            >
              {allowAnyVariant && <s-option value="">Any variant</s-option>}
              {product.variants.map((variant) => (
                <s-option key={variant.variantGid} value={variant.variantGid}>
                  {variant.title} — {variant.price}
                  {variant.availableForSale ? "" : " (unavailable)"}
                </s-option>
              ))}
            </s-select>
            <s-button
              disabled={!allowAnyVariant && !choice}
              onClick={() => onPick(product, choice)}
            >
              Add
            </s-button>
          </s-stack>
        );
      })}
    </s-stack>
  );
}

function quantity(
  value: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function RuleEditor({
  mode,
  initial,
  errors = {},
  cancelHref,
  maxOffers: planMaxOffers,
}: {
  mode: "create" | "edit";
  initial: RuleDraft;
  errors?: Record<string, string>;
  cancelHref: string;
  /** Plan limit for offers per rule; the server enforces it again. */
  maxOffers?: number;
}) {
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const offerLimit = planMaxOffers ?? 20;

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [status, setStatus] = useState(initial.status);
  const [priority, setPriority] = useState(String(initial.priority));
  const [matchMode, setMatchMode] = useState(initial.matchMode);
  const [heading, setHeading] = useState(initial.heading);
  const [maxOffers, setMaxOffers] = useState(initial.maxOffers);
  const [onProductPage, setOnProductPage] = useState(initial.showOnProductPage);
  const [onCartPage, setOnCartPage] = useState(initial.showOnCartPage);
  const [triggers, setTriggers] = useState<TriggerDraft[]>(initial.triggers);
  const [offers, setOffers] = useState<OfferDraft[]>(initial.offers);

  const addTrigger = (product: PickerProduct, variantGid: string) => {
    if (
      triggers.some(
        (trigger) =>
          trigger.productGid === product.productGid && trigger.variantGid === variantGid,
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

  const addOffer = (product: PickerProduct, variantGid: string) => {
    const variant = product.variants.find((item) => item.variantGid === variantGid);
    if (!variant || offers.some((offer) => offer.variantGid === variantGid)) return;
    if (offers.length >= offerLimit) return;

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

  const updateOffer = (variantGid: string, patch: Partial<OfferDraft>) => {
    setOffers((current) =>
      current.map((offer) =>
        offer.variantGid === variantGid ? { ...offer, ...patch } : offer,
      ),
    );
  };

  return (
    <Form method="post">
      <input type="hidden" name="triggers" value={JSON.stringify(triggers)} />
      <input type="hidden" name="offers" value={JSON.stringify(offers)} />
      <s-page heading={mode === "create" ? "New rule" : "Edit rule"}>
        <s-stack direction="block" gap="base">
          {errors.form && (
            <s-banner tone="critical" heading="Rule not saved">
              <s-paragraph>{errors.form}</s-paragraph>
            </s-banner>
          )}

          <s-section heading="Rule">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Name"
                name="name"
                value={name}
                required
                {...(errors.name ? { error: errors.name } : {})}
                onInput={(event) => setName(event.currentTarget.value)}
              />
              <s-text-area
                label="Description (internal)"
                name="description"
                value={description}
                rows={2}
                {...(errors.description ? { error: errors.description } : {})}
                onInput={(event) => setDescription(event.currentTarget.value)}
              />
              <s-stack direction="inline" gap="base">
                <s-select
                  label="Status"
                  name="status"
                  value={status}
                  onChange={(event) =>
                    setStatus(event.currentTarget.value as RuleDraft["status"])
                  }
                >
                  <s-option value="DRAFT">Draft</s-option>
                  <s-option value="ACTIVE">Active</s-option>
                  <s-option value="PAUSED">Paused</s-option>
                </s-select>
                <s-number-field
                  label="Priority (lower wins)"
                  name="priority"
                  value={priority}
                  min={0}
                  {...(errors.priority ? { error: errors.priority } : {})}
                  onChange={(event) => setPriority(event.currentTarget.value)}
                />
                <s-number-field
                  label="Max offers (optional)"
                  name="maxOffers"
                  value={maxOffers}
                  min={1}
                  max={10}
                  {...(errors.maxOffers ? { error: errors.maxOffers } : {})}
                  onChange={(event) => setMaxOffers(event.currentTarget.value)}
                />
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Display">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Heading shown to buyers"
                name="heading"
                value={heading}
                placeholder="Pairs well with"
                {...(errors.heading ? { error: errors.heading } : {})}
                onInput={(event) => setHeading(event.currentTarget.value)}
              />
              <s-stack direction="inline" gap="base">
                <s-checkbox
                  label="Show on product page"
                  name="showOnProductPage"
                  checked={onProductPage}
                  onChange={(event) => setOnProductPage(event.currentTarget.checked)}
                />
                <s-checkbox
                  label="Show on cart page"
                  name="showOnCartPage"
                  checked={onCartPage}
                  onChange={(event) => setOnCartPage(event.currentTarget.checked)}
                />
              </s-stack>
              {errors.surfaces && (
                <s-text tone="critical">{errors.surfaces}</s-text>
              )}
            </s-stack>
          </s-section>

          <s-section heading="Triggers">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                The rule shows offers when a cart line matches a trigger. A specific
                variant trigger only matches that variant.
              </s-paragraph>
              <s-select
                label="Match mode"
                name="matchMode"
                value={matchMode}
                onChange={(event) =>
                  setMatchMode(event.currentTarget.value as RuleDraft["matchMode"])
                }
              >
                <s-option value="ANY">Any trigger matches</s-option>
                <s-option value="ALL">All triggers must match</s-option>
              </s-select>

              {triggers.length === 0 && <s-paragraph>No trigger products yet.</s-paragraph>}

              {triggers.map((trigger) => (
                <s-stack
                  key={`${trigger.productGid}|${trigger.variantGid}`}
                  direction="inline"
                  gap="base"
                >
                  {trigger.imageUrl ? (
                    <s-thumbnail src={trigger.imageUrl} alt={trigger.title} size="small" />
                  ) : null}
                  <s-text>
                    {trigger.title}
                    {trigger.variantTitle ? ` — ${trigger.variantTitle}` : " — any variant"}
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

              {errors.triggers && <s-text tone="critical">{errors.triggers}</s-text>}

              <s-divider />
              <ProductSearch
                label="Add trigger product"
                allowAnyVariant
                onPick={addTrigger}
              />
            </s-stack>
          </s-section>

          <s-section heading="Offers">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Offers are added to the buyer&apos;s existing cart. Quantities limit
                what the buyer can select.
              </s-paragraph>
              <s-paragraph>
                {offers.length} of {offerLimit} offers used on this plan.
              </s-paragraph>

              {offers.length === 0 && <s-paragraph>No offers yet.</s-paragraph>}

              {offers.map((offer) => (
                <s-stack key={offer.variantGid} direction="block" gap="small">
                  <s-stack direction="inline" gap="base">
                    {offer.imageUrl ? (
                      <s-thumbnail src={offer.imageUrl} alt={offer.title} size="small" />
                    ) : null}
                    <s-text>
                      {offer.title} — {offer.variantTitle}
                      {offer.price ? ` (${offer.price})` : ""}
                    </s-text>
                    <s-button
                      variant="tertiary"
                      onClick={() =>
                        setOffers((current) =>
                          current.filter((item) => item.variantGid !== offer.variantGid),
                        )
                      }
                    >
                      Remove
                    </s-button>
                  </s-stack>
                  <s-stack direction="inline" gap="base">
                    <s-number-field
                      label="Min qty"
                      value={String(offer.minQuantity)}
                      min={1}
                      max={100}
                      onChange={(event) =>
                        updateOffer(offer.variantGid, {
                          minQuantity: quantity(event.currentTarget.value, 1, 1, 100),
                        })
                      }
                    />
                    <s-number-field
                      label="Default qty"
                      value={String(offer.defaultQuantity)}
                      min={1}
                      max={100}
                      onChange={(event) =>
                        updateOffer(offer.variantGid, {
                          defaultQuantity: quantity(event.currentTarget.value, 1, 1, 100),
                        })
                      }
                    />
                    <s-number-field
                      label="Max qty"
                      value={String(offer.maxQuantity)}
                      min={1}
                      max={100}
                      onChange={(event) =>
                        updateOffer(offer.variantGid, {
                          maxQuantity: quantity(event.currentTarget.value, 10, 1, 100),
                        })
                      }
                    />
                  </s-stack>
                </s-stack>
              ))}

              {errors.offers && <s-text tone="critical">{errors.offers}</s-text>}

              <s-divider />
              {offers.length < offerLimit ? (
                <ProductSearch
                  label="Add offer product"
                  allowAnyVariant={false}
                  onPick={addOffer}
                />
              ) : (
                <s-paragraph>
                  Offer limit reached for this plan.{" "}
                  <s-link href="/app/billing">Review plans</s-link> to add more.
                </s-paragraph>
              )}
            </s-stack>
          </s-section>

          <s-stack direction="inline" gap="base">
            <s-button type="submit" variant="primary" {...(saving ? { loading: true } : {})}>
              {mode === "create" ? "Create rule" : "Save changes"}
            </s-button>
            <s-link href={cancelHref}>Cancel</s-link>
          </s-stack>
        </s-stack>
      </s-page>
    </Form>
  );
}
