import { describe, expect, it } from "vitest";
import {
  conditionsMatch,
  evaluateConditionTree,
} from "../../app/utils/condition-evaluator";
import type {
  ConditionContext,
  TriState,
} from "../../app/utils/condition-evaluator";
import type {
  ConditionGroupNode,
  ConditionNode,
} from "../../app/utils/condition-schema";

function condition(
  field: ConditionNode["field"],
  operator: ConditionNode["operator"],
  valueJson: unknown,
): ConditionNode {
  return { field, operator, valueJson };
}

function group(
  joinOp: "AND" | "OR",
  conditions: ConditionNode[] = [],
  children: ConditionGroupNode[] = [],
): ConditionGroupNode {
  return { joinOp, conditions, children };
}

function constantCondition(value: TriState): ConditionNode {
  // Logged-in resolves true or false from context; missing shipping resolves
  // unknown regardless of the login context.
  if (value === null) {
    return condition("SHIPPING_COUNTRY", "EQ", "US");
  }
  return condition("CUSTOMER_LOGGED_IN", "EQ", value);
}

const truthTableContext: ConditionContext = {
  customer: { loggedIn: true },
};

function evaluate(root: ConditionGroupNode, context: ConditionContext): TriState {
  return evaluateConditionTree([root], context);
}

describe("tri-state AND and OR", () => {
  const combos: Array<{
    joinOp: "AND" | "OR";
    a: TriState;
    b: TriState;
    expected: TriState;
  }> = [
    { joinOp: "AND", a: true, b: true, expected: true },
    { joinOp: "AND", a: true, b: false, expected: false },
    { joinOp: "AND", a: true, b: null, expected: null },
    { joinOp: "AND", a: false, b: false, expected: false },
    { joinOp: "AND", a: false, b: null, expected: false },
    { joinOp: "AND", a: null, b: null, expected: null },
    { joinOp: "OR", a: true, b: true, expected: true },
    { joinOp: "OR", a: true, b: false, expected: true },
    { joinOp: "OR", a: true, b: null, expected: true },
    { joinOp: "OR", a: false, b: false, expected: false },
    { joinOp: "OR", a: false, b: null, expected: null },
    { joinOp: "OR", a: null, b: null, expected: null },
  ];

  for (const { joinOp, a, b, expected } of combos) {
    it(`${joinOp}(${String(a)}, ${String(b)}) = ${String(expected)}`, () => {
      const tree = group(joinOp, [constantCondition(a), constantCondition(b)]);
      expect(evaluate(tree, truthTableContext)).toBe(expected);
    });
  }

  it("fails closed for OR where every child is unknown", () => {
    const tree = group("OR", [
      condition("SHIPPING_COUNTRY", "EQ", "US"),
      condition("CART_SUBTOTAL", "GTE", 10),
    ]);
    expect(evaluate(tree, {})).toBeNull();
    expect(conditionsMatch([tree], {})).toBe(false);
  });

  it("treats an empty rule as unconstrained", () => {
    expect(evaluateConditionTree([], {})).toBe(true);
    expect(conditionsMatch([], {})).toBe(true);
  });

  it("propagates a nested group result to its parent", () => {
    const tree = group("AND", [condition("CUSTOMER_LOGGED_IN", "EQ", true)], [
      group("OR", [
        condition("SHIPPING_COUNTRY", "EQ", "CA"),
        condition("MARKET_COUNTRY", "EQ", "GB"),
      ]),
    ]);

    expect(
      evaluate(tree, {
        customer: { loggedIn: true },
        shippingCountry: "CA",
      }),
    ).toBe(true);
    expect(
      evaluate(tree, {
        customer: { loggedIn: true },
        shippingCountry: "US",
        marketCountry: "GB",
      }),
    ).toBe(true);
    expect(
      evaluate(tree, {
        customer: { loggedIn: true },
        shippingCountry: "US",
        marketCountry: "DE",
      }),
    ).toBe(false);
  });
});

describe("context-dependent conditions", () => {
  const lines = [
    { productGid: "gid://shopify/Product/1", quantity: 2 },
    { productGid: "gid://shopify/Product/2", quantity: 1 },
  ];

  it("evaluates cart totals and counts", () => {
    const subtree = group("AND", [
      condition("CART_SUBTOTAL", "GTE", 40),
      condition("CART_LINE_COUNT", "EQ", 2),
    ]);
    expect(
      evaluate(subtree, { cart: { subtotal: 50, lines } }),
    ).toBe(true);
    expect(
      evaluate(subtree, { cart: { subtotal: 10, lines } }),
    ).toBe(false);
    expect(evaluate(subtree, { cart: { lines } })).toBeNull();
  });

  it("counts an empty cart as zero lines, not unknown", () => {
    expect(
      evaluate(group("AND", [condition("CART_LINE_COUNT", "EQ", 0)]), {
        cart: { lines: [] },
      }),
    ).toBe(true);
  });

  it("checks product presence and quantity", () => {
    const contains = group("AND", [
      condition("CART_CONTAINS_PRODUCT", "IN", [
        "gid://shopify/Product/2",
      ]),
    ]);
    expect(evaluate(contains, { cart: { lines } })).toBe(true);

    const excludes = group("AND", [
      condition("CART_CONTAINS_PRODUCT", "NOT_IN", [
        "gid://shopify/Product/2",
      ]),
    ]);
    expect(evaluate(excludes, { cart: { lines } })).toBe(false);
    expect(evaluate(contains, { cart: {} })).toBeNull();

    const quantity = group("AND", [
      condition("CART_QUANTITY_OF_PRODUCT", "EQ", {
        productGid: "gid://shopify/Product/1",
        quantity: 2,
      }),
    ]);
    expect(evaluate(quantity, { cart: { lines } })).toBe(true);
  });

  it("evaluates countries and login with unknown fallbacks", () => {
    expect(
      evaluate(
        group("AND", [
          condition("SHIPPING_COUNTRY", "IN", ["US", "CA"]),
          condition("MARKET_COUNTRY", "NEQ", "DE"),
        ]),
        { shippingCountry: "us", marketCountry: "gb" },
      ),
    ).toBe(true);
    expect(
      evaluate(group("AND", [condition("SHIPPING_COUNTRY", "EQ", "US")]), {}),
    ).toBeNull();
    expect(
      evaluate(group("AND", [condition("CUSTOMER_LOGGED_IN", "EQ", false)]), {
        customer: {},
      }),
    ).toBeNull();
  });

  it("reads post-purchase order values", () => {
    const subtree = group("AND", [
      condition("ORDER_TOTAL", "GT", 100),
      condition("ORDER_LINE_COUNT", "LTE", 5),
    ]);
    expect(evaluate(subtree, { order: { total: 150, lineCount: 3 } })).toBe(true);
    expect(evaluate(subtree, { order: { total: 150 } })).toBeNull();
    expect(evaluate(subtree, {})).toBeNull();
  });
});

describe("time windows", () => {
  const windowValue = { days: [0], start: "03:00", end: "04:00" };

  it("fails closed without a shop time zone", () => {
    const tree = group("AND", [
      condition("TIME_WINDOW", "IN", windowValue),
    ]);
    expect(evaluate(tree, { now: new Date("2026-03-08T07:30:00Z") })).toBeNull();
  });

  it("matches across spring-forward using Intl", () => {
    const tree = group("AND", [
      condition("TIME_WINDOW", "IN", windowValue),
    ]);
    expect(
      evaluate(tree, {
        timeZone: "America/New_York",
        now: new Date("2026-03-08T07:30:00Z"),
      }),
    ).toBe(true);
  });

  it("matches across fall-back using Intl", () => {
    const fallWindow = { days: [0], start: "01:00", end: "02:00" };
    const tree = group("AND", [
      condition("TIME_WINDOW", "IN", fallWindow),
    ]);
    expect(
      evaluate(tree, {
        timeZone: "America/New_York",
        now: new Date("2026-11-01T06:30:00Z"),
      }),
    ).toBe(true);
  });

  it("respects weekdays and NOT_IN", () => {
    const tree = group("AND", [
      condition("TIME_WINDOW", "IN", { days: [1], start: "09:00", end: "17:00" }),
    ]);
    expect(
      evaluate(tree, {
        timeZone: "Europe/London",
        now: new Date("2026-03-08T12:00:00Z"),
      }),
    ).toBe(false);

    const outside = group("AND", [
      condition("TIME_WINDOW", "NOT_IN", {
        days: [1],
        start: "09:00",
        end: "17:00",
      }),
    ]);
    expect(
      evaluate(outside, {
        timeZone: "Europe/London",
        now: new Date("2026-03-08T12:00:00Z"),
      }),
    ).toBe(true);
  });

  it("fails closed for an unusable stored window or time zone", () => {
    const tree = group("AND", [
      condition("TIME_WINDOW", "IN", {
        days: [0],
        start: "17:00",
        end: "09:00",
      }),
    ]);
    expect(
      evaluate(tree, {
        timeZone: "America/New_York",
        now: new Date("2026-03-08T07:30:00Z"),
      }),
    ).toBeNull();

    const valid = group("AND", [
      condition("TIME_WINDOW", "IN", windowValue),
    ]);
    expect(
      evaluate(valid, {
        timeZone: "Not/AZone",
        now: new Date("2026-03-08T07:30:00Z"),
      }),
    ).toBeNull();
  });
});

describe("no context leaks between evaluations", () => {
  it("does not retain a previous context", () => {
    const tree = group("AND", [
      condition("CART_SUBTOTAL", "GTE", 10),
    ]);
    expect(evaluate(tree, { cart: { subtotal: 20 } })).toBe(true);
    expect(evaluate(tree, { cart: {} })).toBeNull();
  });
});
