import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS_PER_REQUEST,
  parseStorefrontEventBatch,
} from "../../app/utils/analytics-input";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OFFER_ID = "cm3xk9q2b0000abcd1234efgh";

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventType: "IMPRESSION",
    surface: "product",
    ruleId: "cm3xk9q2b0000ruledifferent1",
    offerId: OFFER_ID,
    offerProductGid: "gid://shopify/Product/1",
    offerVariantGid: "gid://shopify/ProductVariant/2",
    sessionKey: SESSION,
    dedupeKey: `${SESSION}:IMPRESSION:gid://shopify/ProductVariant/2`,
    ...overrides,
  };
}

describe("storefront event parsing", () => {
  it("keeps the fields the server actually uses", () => {
    const [parsed] = parseStorefrontEventBatch(event());

    expect(parsed).toEqual({
      eventType: "IMPRESSION",
      surface: "PRODUCT_PAGE",
      experience: null,
      declineReason: null,
      offerId: OFFER_ID,
      sessionKey: SESSION,
      dedupeKey: `${SESSION}:IMPRESSION:gid://shopify/ProductVariant/2`,
    });
  });

  it("accepts a batch object and caps the batch size", () => {
    const events = Array.from({ length: MAX_EVENTS_PER_REQUEST + 5 }, (_, index) =>
      event({ offerId: `cm3xk9q2b0000abcd1234${String(index).padStart(4, "0")}` }),
    );

    const parsed = parseStorefrontEventBatch({ events });
    expect(parsed).toHaveLength(MAX_EVENTS_PER_REQUEST);
  });

  it("accepts checkout event types that the platform emits", () => {
    const parsed = parseStorefrontEventBatch([
      event({ eventType: "CLICK" }),
      event({ eventType: "OFFER_ACCEPTED" }),
      event({ eventType: "OFFER_DECLINED" }),
    ]);

    expect(parsed.map((item) => item.eventType)).toEqual([
      "CLICK",
      "OFFER_ACCEPTED",
      "OFFER_DECLINED",
    ]);
  });

  it("rejects server-derived event types", () => {
    expect(parseStorefrontEventBatch(event({ eventType: "ORDER_ATTRIBUTED" }))).toEqual([]);
    expect(parseStorefrontEventBatch(event({ eventType: "NOPE" }))).toEqual([]);
  });

  it("requires a known experience for checkout events", () => {
    const base = { surface: "checkout", eventType: "IMPRESSION" };

    expect(
      parseStorefrontEventBatch(event({ ...base, experience: "PRE_PURCHASE" }))[0]?.experience,
    ).toBe("PRE_PURCHASE");
    expect(
      parseStorefrontEventBatch(event({ ...base, experience: "POST_PURCHASE" }))[0]?.experience,
    ).toBe("POST_PURCHASE");
    expect(parseStorefrontEventBatch(event(base))).toEqual([]);
    expect(parseStorefrontEventBatch(event({ ...base, experience: "MID_PURCHASE" }))).toEqual([]);
  });

  it("keeps legacy surfaces without an experience", () => {
    const [parsed] = parseStorefrontEventBatch(event({ surface: "cart" }));
    expect(parsed?.surface).toBe("CART_PAGE");
    expect(parsed?.experience).toBeNull();
  });

  it("defaults and validates decline reasons on failures", () => {
    const base = { surface: "checkout", experience: "POST_PURCHASE" };

    const [defaulted] = parseStorefrontEventBatch(
      event({ ...base, eventType: "ADD_FAILURE" }),
    );
    expect(defaulted?.declineReason).toBe("UNKNOWN");

    const [explicit] = parseStorefrontEventBatch(
      event({ ...base, eventType: "OFFER_DECLINED", declineReason: "OUT_OF_STOCK" }),
    );
    expect(explicit?.declineReason).toBe("OUT_OF_STOCK");

    expect(
      parseStorefrontEventBatch(
        event({ ...base, eventType: "ADD_FAILURE", declineReason: "ALIENS" }),
      ),
    ).toEqual([]);

    const [ignored] = parseStorefrontEventBatch(
      event({ ...base, eventType: "IMPRESSION", declineReason: "OUT_OF_STOCK" }),
    );
    expect(ignored?.declineReason).toBeNull();
  });

  it("rejects unknown surfaces", () => {
    expect(parseStorefrontEventBatch(event({ surface: "thank_you" }))).toEqual([]);
  });

  it("rejects malformed offer and session identifiers", () => {
    expect(parseStorefrontEventBatch(event({ offerId: "bad offer id!" }))).toEqual([]);
    expect(parseStorefrontEventBatch(event({ offerId: "short" }))).toEqual([]);
    expect(parseStorefrontEventBatch(event({ sessionKey: "short" }))).toEqual([]);
    expect(
      parseStorefrontEventBatch(event({ sessionKey: "<script>alert(1)</script>" })),
    ).toEqual([]);
  });

  it("accepts synthetic automatic offer ids", () => {
    const [parsed] = parseStorefrontEventBatch(
      event({ offerId: "auto:cm3xk9q2b0000abcd1234efgh:502:50201" }),
    );
    expect(parsed?.offerId).toBe("auto:cm3xk9q2b0000abcd1234efgh:502:50201");
  });

  it("derives a dedupe key when the client omits one", () => {
    const [parsed] = parseStorefrontEventBatch(event({ dedupeKey: undefined }));
    expect(parsed.dedupeKey).toBe(`${SESSION}:IMPRESSION:${OFFER_ID}`);
  });

  it("drops one bad item without losing the good ones", () => {
    const parsed = parseStorefrontEventBatch([
      event(),
      event({ eventType: "NOPE" }),
      event({ eventType: "ADD_SUCCESS" }),
    ]);

    expect(parsed.map((item) => item.eventType)).toEqual([
      "IMPRESSION",
      "ADD_SUCCESS",
    ]);
  });

  it("returns an empty list for junk input", () => {
    expect(parseStorefrontEventBatch(null)).toEqual([]);
    expect(parseStorefrontEventBatch("not json")).toEqual([]);
    expect(parseStorefrontEventBatch({ events: "nope" })).toEqual([]);
  });
});
