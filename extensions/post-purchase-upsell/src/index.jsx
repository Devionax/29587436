import { useEffect, useRef, useState } from "react";
import {
  BlockStack,
  Button,
  CalloutBanner,
  extend,
  Heading,
  render,
  Separator,
  Text,
  TextBlock,
  TextContainer,
  Tiles,
  useExtensionInput,
} from "@shopify/post-purchase-ui-extensions-react";
import { APP_ORIGIN } from "./app-origin.js";

/**
 * Post-purchase upsell.
 *
 * `ShouldRender` asks the app backend for offers using the Shopify-issued
 * token, stores the payload and decides whether the page renders at all.
 * `Render` shows those offers; accepting signs a changeset on the backend and
 * applies it to the order. Any failure hides the page or shows a message,
 * never blocks the buyer from reaching the thank-you page.
 */

const POST_PURCHASE = "POST_PURCHASE";
const MAX_OFFERS = 3;

function randomKey() {
  let key = "";
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      for (let index = 0; index < bytes.length; index += 1) {
        key += bytes[index].toString(16).padStart(2, "0");
      }
      return key;
    }
  } catch {
    // Fall through to Math.random in sandboxes without crypto.
  }
  for (let index = 0; index < 32; index += 1) {
    key += Math.floor(Math.random() * 16).toString(16);
  }
  return key;
}

function formatMoney(amount, currencyCode) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "";

  if (currencyCode && typeof Intl !== "undefined" && Intl.NumberFormat) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
      }).format(value);
    } catch {
      // Fall through to a plain amount when the code is rejected.
    }
  }

  return value.toFixed(2) + (currencyCode ? ` ${currencyCode}` : "");
}

function postJson(path, token, body) {
  return fetch(`${APP_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body || {}),
  });
}

extend("Checkout::PostPurchase::ShouldRender", async ({ inputData, storage }) => {
  if (!APP_ORIGIN) {
    console.warn(
      "Upsellora: set APP_ORIGIN in src/app-origin.js before deploying the post-purchase extension.",
    );
    return { render: false };
  }

  try {
    const response = await postJson(
      "/api/post-purchase/offers",
      inputData.token,
      {},
    );
    if (!response.ok) return { render: false };

    const data = await response.json();
    if (
      !data ||
      data.enabled !== true ||
      !Array.isArray(data.offers) ||
      data.offers.length === 0
    ) {
      return { render: false };
    }

    await storage.update({
      heading: typeof data.heading === "string" ? data.heading : null,
      offers: data.offers.slice(0, MAX_OFFERS),
      sessionKey: randomKey(),
    });

    return { render: true };
  } catch {
    return { render: false };
  }
});

render("Checkout::PostPurchase::Render", () => <App />);

function App() {
  const { storage, inputData, applyChangeset, done } = useExtensionInput();
  const initial = storage.initialData || {};
  const offers = Array.isArray(initial.offers) ? initial.offers : [];
  const heading = typeof initial.heading === "string" ? initial.heading : null;
  const sessionKey =
    typeof initial.sessionKey === "string" ? initial.sessionKey : "post-purchase";

  const [added, setAdded] = useState({});
  const [pendingId, setPendingId] = useState(null);
  const [error, setError] = useState(null);
  const impressedRef = useRef(false);

  function sendEvents(events) {
    if (!APP_ORIGIN || events.length === 0) return Promise.resolve();
    return postJson("/api/post-purchase/events", inputData.token, {
      events,
    }).catch(() => {
      // Analytics must never block the page.
    });
  }

  function eventFor(eventType, offer, declineReason) {
    return {
      eventType,
      surface: "checkout",
      experience: POST_PURCHASE,
      declineReason,
      offerId: offer.id,
      sessionKey,
      dedupeKey: `${sessionKey}:${eventType}:${offer.id}`,
    };
  }

  useEffect(() => {
    if (impressedRef.current) return;
    impressedRef.current = true;
    sendEvents(
      offers.map((offer) => eventFor("IMPRESSION", offer, undefined)),
    );
    // Runs once for the offers this page was rendered with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offers]);

  async function accept(offer) {
    setPendingId(offer.id);
    setError(null);
    await sendEvents([
      eventFor("CLICK", offer, undefined),
      eventFor("ADD_ATTEMPT", offer, undefined),
    ]);

    try {
      const response = await postJson(
        "/api/post-purchase/changeset",
        inputData.token,
        { offerId: offer.id },
      );
      if (!response.ok) throw new Error("changeset_not_signed");

      const data = await response.json();
      if (!data || typeof data.token !== "string") {
        throw new Error("changeset_token_missing");
      }

      await applyChangeset(data.token);
      setAdded((previous) => ({ ...previous, [offer.id]: true }));
      await sendEvents([eventFor("OFFER_ACCEPTED", offer, undefined)]);
    } catch {
      setError(
        "We could not add this item to your order. You can continue without it.",
      );
      await sendEvents([eventFor("ADD_FAILURE", offer, "UNKNOWN")]);
    } finally {
      setPendingId(null);
    }
  }

  async function finish() {
    const declined = offers.filter((offer) => !added[offer.id]);
    await sendEvents(
      declined.map((offer) => eventFor("OFFER_DECLINED", offer, undefined)),
    );
    done();
  }

  if (offers.length === 0) return null;

  const busy = pendingId !== null;

  return (
    <BlockStack spacing="loose">
      <CalloutBanner>
        <TextContainer>
          <Text size="medium" emphasized>
            {heading || "One more thing before you go"}
          </Text>
        </TextContainer>
      </CalloutBanner>

      {offers.map((offer) => (
        <BlockStack key={offer.id} spacing="tight">
          <Heading>{offer.headline}</Heading>
          {offer.variantTitle && offer.variantTitle !== "Default Title" ? (
            <TextBlock subdued>{offer.variantTitle}</TextBlock>
          ) : null}
          {offer.body ? <TextBlock>{offer.body}</TextBlock> : null}
          <Tiles>
            <TextBlock emphasized>
              {formatMoney(offer.price, offer.currencyCode)}
            </TextBlock>
            <TextContainer alignment="trailing">
              <Button
                onPress={() => accept(offer)}
                submit
                disabled={busy || Boolean(added[offer.id])}
              >
                {added[offer.id]
                  ? "Added to order"
                  : pendingId === offer.id
                    ? "Adding…"
                    : offer.ctaLabel}
              </Button>
            </TextContainer>
          </Tiles>
          <Separator />
        </BlockStack>
      ))}

      {error ? (
        <TextBlock appearance="critical" emphasized>
          {error}
        </TextBlock>
      ) : null}

      <Button onPress={finish} disabled={busy} subdued>
        Continue to thank you
      </Button>
    </BlockStack>
  );
}
