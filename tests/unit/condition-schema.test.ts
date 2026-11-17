import { describe, expect, it } from "vitest";
import {
  CONDITION_LIMITS,
  assertConditionsSupported,
  assertValidIanaTimeZone,
  isConditionSupported,
  normalizeCondition,
  validateConditionTree,
} from "../../app/utils/condition-schema";
import type { ConditionGroupNode } from "../../app/utils/condition-schema";
import { InvalidInputError } from "../../app/utils/errors";

function normalize(
  field: Parameters<typeof normalizeCondition>[0]["field"],
  operator: Parameters<typeof normalizeCondition>[0]["operator"],
  value: unknown,
) {
  return normalizeCondition({ field, operator, value });
}

function leaf(
  field: Parameters<typeof normalizeCondition>[0]["field"],
  operator: Parameters<typeof normalizeCondition>[0]["operator"],
  value: unknown,
): ConditionGroupNode {
  return {
    joinOp: "AND",
    conditions: [{ field, operator, valueJson: value }],
  };
}

describe("condition value validation", () => {
  it("accepts non-negative decimal totals and whole counts", () => {
    expect(normalize("CART_SUBTOTAL", "GTE", 49.99).valueJson).toBe(49.99);
    expect(normalize("CART_LINE_COUNT", "EQ", 0).valueJson).toBe(0);
    expect(normalize("ORDER_TOTAL", "LT", 100).valueJson).toBe(100);
    expect(normalize("ORDER_LINE_COUNT", "GT", 2).valueJson).toBe(2);
  });

  it("rejects negative, non-finite, and fractional counts", () => {
    expect(() => normalize("CART_SUBTOTAL", "GT", -1)).toThrow(InvalidInputError);
    expect(() => normalize("CART_SUBTOTAL", "GT", Number.NaN)).toThrow(
      InvalidInputError,
    );
    expect(() => normalize("CART_SUBTOTAL", "GT", "10")).toThrow(
      InvalidInputError,
    );
    expect(() => normalize("CART_LINE_COUNT", "EQ", 1.5)).toThrow(
      InvalidInputError,
    );
  });

  it("rejects operators a field does not support", () => {
    expect(() => normalize("CART_SUBTOTAL", "IN", [1])).toThrow(
      InvalidInputError,
    );
    expect(() => normalize("CUSTOMER_LOGGED_IN", "GT", true)).toThrow(
      InvalidInputError,
    );
    expect(() => normalize("CART_CONTAINS_PRODUCT", "EQ", "gid://shopify/Product/1")).toThrow(
      InvalidInputError,
    );
  });

  it("validates product GID lists", () => {
    expect(
      normalize("CART_CONTAINS_PRODUCT", "IN", [
        "gid://shopify/Product/1",
        "gid://shopify/Product/2",
      ]).valueJson,
    ).toEqual(["gid://shopify/Product/1", "gid://shopify/Product/2"]);

    expect(() =>
      normalize("CART_CONTAINS_PRODUCT", "IN", ["gid://shopify/ProductVariant/1"]),
    ).toThrow(InvalidInputError);
    expect(() => normalize("CART_CONTAINS_PRODUCT", "NOT_IN", [])).toThrow(
      InvalidInputError,
    );
  });

  it("validates product quantity objects", () => {
    expect(
      normalize("CART_QUANTITY_OF_PRODUCT", "GTE", {
        productGid: "gid://shopify/Product/1",
        quantity: 2,
      }).valueJson,
    ).toEqual({ productGid: "gid://shopify/Product/1", quantity: 2 });

    expect(() =>
      normalize("CART_QUANTITY_OF_PRODUCT", "GTE", {
        productGid: "gid://shopify/Product/1",
        quantity: -1,
      }),
    ).toThrow(InvalidInputError);
    expect(() =>
      normalize("CART_QUANTITY_OF_PRODUCT", "GTE", {
        productGid: "nope",
        quantity: 1,
      }),
    ).toThrow(InvalidInputError);
  });

  it("requires boolean login values", () => {
    expect(normalize("CUSTOMER_LOGGED_IN", "EQ", true).valueJson).toBe(true);
    expect(() => normalize("CUSTOMER_LOGGED_IN", "EQ", "true")).toThrow(
      InvalidInputError,
    );
  });

  it("normalizes country codes to uppercase", () => {
    expect(normalize("SHIPPING_COUNTRY", "EQ", "us").valueJson).toBe("US");
    expect(
      normalize("MARKET_COUNTRY", "IN", ["ca", "gb"]).valueJson,
    ).toEqual(["CA", "GB"]);
    expect(() => normalize("SHIPPING_COUNTRY", "EQ", "USA")).toThrow(
      InvalidInputError,
    );
    expect(() => normalize("SHIPPING_COUNTRY", "IN", [])).toThrow(
      InvalidInputError,
    );
  });

  it("normalizes time windows and rejects impossible ones", () => {
    expect(
      normalize("TIME_WINDOW", "IN", {
        days: [1, 1, 3],
        start: "09:00",
        end: "17:30",
      }).valueJson,
    ).toEqual({ days: [1, 3], start: "09:00", end: "17:30" });

    expect(() =>
      normalize("TIME_WINDOW", "IN", {
        days: [7],
        start: "09:00",
        end: "17:00",
      }),
    ).toThrow(InvalidInputError);
    expect(() =>
      normalize("TIME_WINDOW", "IN", {
        days: [1],
        start: "17:00",
        end: "09:00",
      }),
    ).toThrow(InvalidInputError);
    expect(() =>
      normalize("TIME_WINDOW", "IN", {
        days: [1],
        start: "9am",
        end: "17:00",
      }),
    ).toThrow(InvalidInputError);
    expect(() => normalize("TIME_WINDOW", "EQ", { days: [1] })).toThrow(
      InvalidInputError,
    );
  });
});

describe("condition tree validation", () => {
  it("accepts a two-level tree", () => {
    const tree: ConditionGroupNode[] = [
      {
        joinOp: "AND",
        conditions: [
          {
            field: "CART_SUBTOTAL",
            operator: "GTE",
            valueJson: 25,
          },
        ],
        children: [
          leaf("SHIPPING_COUNTRY", "EQ", "US"),
          leaf("CUSTOMER_LOGGED_IN", "EQ", true),
        ],
      },
    ];

    expect(() => validateConditionTree(tree)).not.toThrow();
  });

  it("rejects empty groups", () => {
    expect(() =>
      validateConditionTree([{ joinOp: "AND", conditions: [], children: [] }]),
    ).toThrow(InvalidInputError);
  });

  it("rejects a third level", () => {
    const tree: ConditionGroupNode[] = [
      {
        joinOp: "AND",
        children: [
          {
            joinOp: "OR",
            children: [leaf("SHIPPING_COUNTRY", "EQ", "US")],
          },
        ],
      },
    ];

    expect(() => validateConditionTree(tree)).toThrow(InvalidInputError);
  });

  it("enforces group and condition caps", () => {
    const groups = Array.from(
      { length: CONDITION_LIMITS.maxGroups + 1 },
      () => leaf("SHIPPING_COUNTRY", "EQ", "US"),
    );
    expect(() => validateConditionTree(groups)).toThrow(InvalidInputError);

    const conditions = Array.from(
      { length: CONDITION_LIMITS.maxConditions + 1 },
      (_, index) => ({
        field: "CART_SUBTOTAL" as const,
        operator: "GTE" as const,
        valueJson: index,
      }),
    );
    expect(() =>
      validateConditionTree([{ joinOp: "AND", conditions }]),
    ).toThrow(InvalidInputError);
  });

  it("rejects a stored value that no longer validates", () => {
    expect(() =>
      validateConditionTree([
        {
          joinOp: "AND",
          conditions: [
            {
              field: "SHIPPING_COUNTRY",
              operator: "EQ",
              valueJson: "USA",
            },
          ],
        },
      ]),
    ).toThrow(InvalidInputError);
  });
});

describe("experience support", () => {
  it("offers cart fields only before purchase and order fields only after", () => {
    expect(isConditionSupported("PRE_PURCHASE", "CART_SUBTOTAL")).toBe(true);
    expect(isConditionSupported("POST_PURCHASE", "CART_SUBTOTAL")).toBe(false);
    expect(isConditionSupported("POST_PURCHASE", "ORDER_TOTAL")).toBe(true);
    expect(isConditionSupported("PRE_PURCHASE", "ORDER_TOTAL")).toBe(false);
  });

  it("rejects unsupported fields instead of dropping them", () => {
    expect(() =>
      assertConditionsSupported("POST_PURCHASE", [
        "CUSTOMER_LOGGED_IN",
        "CART_LINE_COUNT",
      ]),
    ).toThrow(InvalidInputError);
    expect(() =>
      assertConditionsSupported("PRE_PURCHASE", [
        "CUSTOMER_LOGGED_IN",
        "CART_LINE_COUNT",
      ]),
    ).not.toThrow();
  });
});

describe("time zone validation", () => {
  it("accepts IANA identifiers and rejects unknown ones", () => {
    expect(() => assertValidIanaTimeZone("America/New_York")).not.toThrow();
    expect(() => assertValidIanaTimeZone("Europe/London")).not.toThrow();
    expect(() => assertValidIanaTimeZone("Not/AZone")).toThrow(InvalidInputError);
  });
});
