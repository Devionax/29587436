import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  useApplyCartLinesChange,
  useCartLines,
  useLocalizationCountry,
  useSessionToken,
  useShippingAddress,
  useSubtotalAmount,
} from "@shopify/ui-extensions/checkout/preact";
import { APP_ORIGIN } from "./app-origin.js";

/**
 * Pre-purchase upsell block for `purchase.checkout.block.render`.
 *
 * The extension renders nothing until the backend returns offers. Prices and
 * availability always come from the backend, which reads ProductSnapshot;
 * cart contents are sent only as relevance hints.
 */

const PRE_PURCHASE = "PRE_PURCHASE";

function randomKey() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatMoney(amount, currencyCode) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "";

  if (currencyCode) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
      }).format(value);
    } catch {
      // Fall through to a plain amount when the browser rejects the code.
    }
  }

  return value.toFixed(2);
}

function declineReasonFor(message) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (text.includes("stock") || text.includes("sold out")) return "OUT_OF_STOCK";
  if (text.includes("unavailable") || text.includes("not available")) {
    return "VARIANT_UNAVAILABLE";
  }
  if (text.includes("limit") || text.includes("maximum")) return "CART_LIMIT";
  return "UNKNOWN";
}

function Extension() {
  const cartLines = useCartLines();
  const subtotal = useSubtotalAmount();
  const country = useLocalizationCountry();
  const shippingAddress = useShippingAddress();
  const sessionToken = useSessionToken();
  const applyCartLinesChange = useApplyCartLinesChange();

  const [heading, setHeading] = useState(null);
  const [offers, setOffers] = useState([]);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null);
  const [added, setAdded] = useState({});

  // Lazy initializer keeps one pseudonymous key per extension instance.
  const [sessionKey] = useState(randomKey);
  const impressedRef = useRef(new Set());

  const lineKey = cartLines
    .map((line) => `${line.merchandise?.id ?? ""}x${line.quantity}`)
    .sort()
    .join("|");

  const contextKey = useMemo(
    () =>
      [
        lineKey,
        Number(subtotal?.amount ?? 0).toFixed(2),
        country?.isoCode ?? "",
        shippingAddress?.countryCode ?? "",
      ].join(";"),
    [lineKey, subtotal?.amount, country?.isoCode, shippingAddress?.countryCode],
  );

  const sendEvents = useCallback(
    async (events) => {
      if (!APP_ORIGIN || events.length === 0) return;
      try {
        const token = await sessionToken.get();
        await fetch(`${APP_ORIGIN}/api/checkout/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ events }),
        });
      } catch {
        // Analytics must never block the checkout.
      }
    },
    [sessionToken],
  );

  const emit = useCallback(
    async (eventType, offer, declineReason) => {
      await sendEvents([
        {
          eventType,
          surface: "checkout",
          experience: PRE_PURCHASE,
          declineReason,
          offerId: offer.id,
          sessionKey,
          dedupeKey: `${sessionKey}:${eventType}:${offer.id}`,
        },
      ]);
    },
    [sendEvents, sessionKey],
  );

  useEffect(() => {
    if (!APP_ORIGIN) {
      console.warn(
        "Upsellora: set APP_ORIGIN in src/app-origin.js before deploying the checkout extension.",
      );
      return undefined;
    }
    if (cartLines.length === 0) {
      setOffers([]);
      setHeading(null);
      return undefined;
    }

    let cancelled = false;

    async function load() {
      try {
        const token = await sessionToken.get();
        const response = await fetch(`${APP_ORIGIN}/api/checkout/offers`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            lines: cartLines.map((line) => ({
              productGid: line.merchandise?.product?.id,
              variantGid: line.merchandise?.id,
              quantity: line.quantity,
            })),
            subtotal: Number(subtotal?.amount ?? 0),
            country: country?.isoCode ?? null,
            shippingCountry: shippingAddress?.countryCode ?? null,
          }),
        });

        if (!response.ok) return;
        const data = await response.json();
        if (cancelled || !data || typeof data !== "object") return;

        setHeading(typeof data.heading === "string" ? data.heading : null);
        setOffers(Array.isArray(data.offers) ? data.offers : []);
        setError(null);
      } catch {
        // Keep whatever was rendered before; a failed refresh must not clear it.
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // contextKey summarizes the cart, subtotal and location inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey]);

  useEffect(() => {
    for (const offer of offers) {
      if (impressedRef.current.has(offer.id)) continue;
      impressedRef.current.add(offer.id);
      void emit("IMPRESSION", offer);
    }
  }, [offers, emit]);

  const cartVariants = useMemo(
    () =>
      new Set(
        cartLines
          .map((line) => line.merchandise?.id)
          .filter((value) => Boolean(value)),
      ),
    [cartLines],
  );

  const visible = offers.filter((offer) => !cartVariants.has(offer.variantGid));

  async function addOffer(offer) {
    setPendingId(offer.id);
    setError(null);
    await emit("CLICK", offer);
    await emit("ADD_ATTEMPT", offer);

    try {
      const result = await applyCartLinesChange({
        type: "addCartLine",
        merchandiseId: offer.variantGid,
        quantity: offer.quantity,
      });

      if (result?.type === "success") {
        setAdded((previous) => ({ ...previous, [offer.id]: true }));
        await emit("ADD_SUCCESS", offer);
      } else {
        setError("That item could not be added. Please try again.");
        await emit("ADD_FAILURE", offer, declineReasonFor(result?.message));
      }
    } catch {
      setError("That item could not be added. Please try again.");
      await emit("ADD_FAILURE", offer, "NETWORK");
    } finally {
      setPendingId(null);
    }
  }

  if (!APP_ORIGIN || visible.length === 0) return null;

  return (
    <s-stack direction="block" gap="base">
      {heading ? <s-heading>{heading}</s-heading> : null}

      {visible.map((offer) => (
        <s-box
          key={offer.id}
          padding="base"
          border="base"
          borderRadius="large-100"
        >
          <s-stack direction="block" gap="small">
            <s-text type="strong">{offer.headline}</s-text>
            {offer.variantTitle && offer.variantTitle !== "Default Title" ? (
              <s-text color="subdued">{offer.variantTitle}</s-text>
            ) : null}
            {offer.body ? <s-text>{offer.body}</s-text> : null}
            <s-text type="strong">
              {formatMoney(offer.price, offer.currencyCode)}
            </s-text>
            <s-button
              disabled={pendingId === offer.id}
              onClick={() => void addOffer(offer)}
            >
              {added[offer.id] ? "Added" : offer.ctaLabel}
            </s-button>
          </s-stack>
        </s-box>
      ))}

      {error ? <s-banner tone="critical">{error}</s-banner> : null}
    </s-stack>
  );
}

export default function extension() {
  render(<Extension />, document.body);
}
