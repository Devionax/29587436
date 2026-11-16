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

  it("rejects unknown event types and post-purchase events", () => {
    expect(parseStorefrontEventBatch(event({ eventType: "ORDER_ATTRIBUTED" }))).toEqual([]);
    expect(parseStorefrontEventBatch(event({ eventType: "CLICK" }))).toEqual([]);
  });

  it("rejects unknown surfaces", () => {
    expect(parseStorefrontEventBatch(event({ surface: "checkout" }))).toEqual([]);
  });

  it("rejects malformed offer and session identifiers", () => {
    expect(parseStorefrontEventBatch(event({ offerId: "not-a-cuid" }))).toEqual([]);
    expect(parseStorefrontEventBatch(event({ sessionKey: "short" }))).toEqual([]);
    expect(
      parseStorefrontEventBatch(event({ sessionKey: "<script>alert(1)</script>" })),
    ).toEqual([]);
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
