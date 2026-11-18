import { useEffect, useRef, useState } from "react";
import {
  BlockStack,
  Button,
  CalloutBanner,
  extend,
  Heading,
  Image,
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
 *
 * Requests go through the shop's App Proxy (`/apps/upsell/post-purchase/*`),
 * which stays valid across dev tunnels and deployments. `APP_ORIGIN` overrides
 * that base when the proxy is not the right path.
 */

const POST_PURCHASE = "POST_PURCHASE";
const MAX_OFFERS = 3;
const PROXY_PATH = "/apps/upsell/post-purchase";

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

/**
 * The token payload is signed, not encrypted, so the shop domain can be read
 * from it to choose the backend host. It is never trusted for anything else:
 * the backend re-verifies the signature on every request.
 */
function shopDomainFromToken(token) {
  try {
    const segment = String(token || "").split(".")[1];
    if (!segment) return null;
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const domain = JSON.parse(json)?.input_data?.shop?.domain;
    return typeof domain === "string" && domain.trim() !== ""
      ? domain.trim()
      : null;
  } catch {
    return null;
  }
}

function domainFromInput(inputData) {
  const domain = inputData?.shop?.domain;
  return typeof domain === "string" && domain.trim() !== ""
    ? domain.trim()
    : null;
}

/** Base URL for `/offers`, `/changeset` and `/events`, or null. */
function apiRoot(inputData) {
  const override = String(APP_ORIGIN || "").trim().replace(/\/+$/, "");
  if (override) return `${override}/api/post-purchase`;

  const domain =
    domainFromInput(inputData) ?? shopDomainFromToken(inputData?.token);
  if (!domain) return null;

  return `https://${domain}${PROXY_PATH}`;
}

function postJson(root, path, token, body) {
  return fetch(`${root}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    // App Proxy forwards headers and body; the token is repeated in the body
    // so the request still authenticates if the header is stripped.
    body: JSON.stringify({ ...(body || {}), token }),
  });
}

extend("Checkout::PostPurchase::ShouldRender", async ({ inputData, storage }) => {
  const root = apiRoot(inputData);
  if (!root) {
    console.warn(
      "Upsellora: no backend origin available for the post-purchase page.",
    );
    return { render: false };
  }

  try {
    const response = await postJson(root, "/offers", inputData.token, {});

    if (!response.ok) {
      console.warn(
        `Upsellora: offer request failed with status ${response.status}.`,
      );
      return { render: false };
    }

    const data = await response.json().catch(() => null);

    if (!data || data.enabled !== true) {
      console.warn(
        "Upsellora: post-purchase delivery is disabled for this shop.",
      );
      return { render: false };
    }

    // An empty list means every rule was filtered out; the backend logs the
    // per-rule reasons and this keeps the Shopify-side outcome visible too.
    if (!Array.isArray(data.offers) || data.offers.length === 0) {
      console.warn(
        "Upsellora: no eligible offer for this purchase, skipping the page.",
      );
      return { render: false };
    }

    await storage.update({
      heading: typeof data.heading === "string" ? data.heading : null,
      offers: data.offers.slice(0, MAX_OFFERS),
      sessionKey: randomKey(),
    });

    return { render: true };
  } catch (error) {
    console.warn("Upsellora: offer request threw.", error?.message || error);
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
  const root = apiRoot(inputData);

  const [added, setAdded] = useState({});
  const [pendingId, setPendingId] = useState(null);
  const [error, setError] = useState(null);
  const impressedRef = useRef(false);

  function sendEvents(events) {
    if (!root || events.length === 0) return Promise.resolve();
    return postJson(root, "/events", inputData.token, { events }).catch(() => {
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
    if (!root || added[offer.id] || pendingId !== null) return;

    setPendingId(offer.id);
    setError(null);
    await sendEvents([
      eventFor("CLICK", offer, undefined),
      eventFor("ADD_ATTEMPT", offer, undefined),
    ]);

    try {
      const response = await postJson(root, "/changeset", inputData.token, {
        offerId: offer.id,
      });
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
          {offer.imageUrl ? (
            <Image source={offer.imageUrl} description={offer.productTitle} />
          ) : null}
          <Heading>{offer.productTitle || offer.headline}</Heading>
          {offer.headline && offer.headline !== offer.productTitle ? (
            <TextBlock emphasized>{offer.headline}</TextBlock>
          ) : null}
          {offer.variantTitle && offer.variantTitle !== "Default Title" ? (
            <TextBlock subdued>{offer.variantTitle}</TextBlock>
          ) : null}
          {offer.body ? <TextBlock>{offer.body}</TextBlock> : null}
          <Tiles>
            <TextContainer>
              {offer.compareAtPrice ? (
                <Text role="deletion">
                  {formatMoney(offer.compareAtPrice, offer.currencyCode)}{" "}
                </Text>
              ) : null}
              <Text emphasized>
                {formatMoney(offer.price, offer.currencyCode)}
              </Text>
            </TextContainer>
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

      {error ? <TextBlock emphasized>{error}</TextBlock> : null}

      <Button onPress={finish} disabled={busy} subdued>
        Continue to thank you
      </Button>
    </BlockStack>
  );
}
