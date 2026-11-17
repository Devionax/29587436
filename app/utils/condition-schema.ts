import type {
  ConditionField,
  ConditionOperator,
  Experience,
} from "@prisma/client";
import { InvalidInputError } from "./errors";

/**
 * Save-time validation for condition trees.
 *
 * Only fields with a verified data source are registered here. Values are
 * normalized before they reach the database so the evaluator can assume a
 * known shape and fail closed on missing context.
 */

export const CONDITION_LIMITS = {
  maxGroups: 5,
  maxConditions: 20,
  maxDepth: 2,
} as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ConditionValueInput = {
  field: ConditionField;
  operator: ConditionOperator;
  value: unknown;
};

export type NormalizedCondition = {
  field: ConditionField;
  operator: ConditionOperator;
  valueJson: JsonValue;
};

const NUMERIC_OPERATORS: ConditionOperator[] = [
  "EQ",
  "NEQ",
  "GT",
  "GTE",
  "LT",
  "LTE",
];
const COUNTRY_OPERATORS: ConditionOperator[] = ["EQ", "NEQ", "IN", "NOT_IN"];
const BOOLEAN_OPERATORS: ConditionOperator[] = ["EQ", "NEQ"];
const PRODUCT_OPERATORS: ConditionOperator[] = ["IN", "NOT_IN"];
const WINDOW_OPERATORS: ConditionOperator[] = ["IN", "NOT_IN"];

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const COUNTRY_CODE = /^[A-Za-z]{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

type FieldSpec = {
  operators: ConditionOperator[];
  normalize: (operator: ConditionOperator, value: unknown) => JsonValue;
};

function fail(message: string): never {
  throw new InvalidInputError(message);
}

function assertOperator(
  field: ConditionField,
  operator: ConditionOperator,
  allowed: ConditionOperator[],
): void {
  if (!allowed.includes(operator)) {
    fail(`${operator} is not supported for ${field}`);
  }
}

function numberValue(
  field: ConditionField,
  value: unknown,
  integer: boolean,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${field} requires a non-negative number`);
  }
  if (integer && !Number.isInteger(value)) {
    fail(`${field} requires a whole number`);
  }
  return value;
}

function stringValue(field: ConditionField, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${field} requires a non-empty string`);
  }
  return value.trim();
}

function productGid(value: unknown): string {
  const gid = stringValue("CART_CONTAINS_PRODUCT", value);
  if (!PRODUCT_GID.test(gid)) {
    fail("Product conditions require a Shopify product GID");
  }
  return gid;
}

function countryCode(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail("Country conditions require a two-letter ISO country code");
  }
  const code = value.trim().toUpperCase();
  if (!COUNTRY_CODE.test(code)) {
    fail("Country conditions require a two-letter ISO country code");
  }
  return code;
}

function assertPlainObject(
  value: unknown,
  field: ConditionField,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${field} requires an object value`);
  }
  return value as Record<string, unknown>;
}

const FIELD_SPECS: Record<ConditionField, FieldSpec> = {
  CART_SUBTOTAL: {
    operators: NUMERIC_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("CART_SUBTOTAL", operator, NUMERIC_OPERATORS);
      return numberValue("CART_SUBTOTAL", value, false);
    },
  },
  CART_LINE_COUNT: {
    operators: NUMERIC_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("CART_LINE_COUNT", operator, NUMERIC_OPERATORS);
      return numberValue("CART_LINE_COUNT", value, true);
    },
  },
  CART_TOTAL_QUANTITY: {
    operators: NUMERIC_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("CART_TOTAL_QUANTITY", operator, NUMERIC_OPERATORS);
      return numberValue("CART_TOTAL_QUANTITY", value, true);
    },
  },
  CART_CONTAINS_PRODUCT: {
    operators: PRODUCT_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("CART_CONTAINS_PRODUCT", operator, PRODUCT_OPERATORS);
      if (!Array.isArray(value) || value.length === 0) {
        fail("CART_CONTAINS_PRODUCT requires at least one product GID");
      }
      return value.map(productGid);
    },
  },
  CART_QUANTITY_OF_PRODUCT: {
    operators: NUMERIC_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("CART_QUANTITY_OF_PRODUCT", operator, NUMERIC_OPERATORS);
      const raw = assertPlainObject(value, "CART_QUANTITY_OF_PRODUCT");
      return {
        productGid: productGid(raw.productGid),
        quantity: numberValue("CART_QUANTITY_OF_PRODUCT", raw.quantity, true),
      };
    },
  },
  CUSTOMER_LOGGED_IN: {
    operators: BOOLEAN_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("CUSTOMER_LOGGED_IN", operator, BOOLEAN_OPERATORS);
      if (typeof value !== "boolean") {
        fail("CUSTOMER_LOGGED_IN requires a boolean value");
      }
      return value;
    },
  },
  SHIPPING_COUNTRY: {
    operators: COUNTRY_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("SHIPPING_COUNTRY", operator, COUNTRY_OPERATORS);
      if (operator === "EQ" || operator === "NEQ") {
        return countryCode(value);
      }
      if (!Array.isArray(value) || value.length === 0) {
        fail("SHIPPING_COUNTRY requires at least one country code");
      }
      return value.map(countryCode);
    },
  },
  MARKET_COUNTRY: {
    operators: COUNTRY_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("MARKET_COUNTRY", operator, COUNTRY_OPERATORS);
      if (operator === "EQ" || operator === "NEQ") {
        return countryCode(value);
      }
      if (!Array.isArray(value) || value.length === 0) {
        fail("MARKET_COUNTRY requires at least one country code");
      }
      return value.map(countryCode);
    },
  },
  ORDER_TOTAL: {
    operators: NUMERIC_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("ORDER_TOTAL", operator, NUMERIC_OPERATORS);
      return numberValue("ORDER_TOTAL", value, false);
    },
  },
  ORDER_LINE_COUNT: {
    operators: NUMERIC_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("ORDER_LINE_COUNT", operator, NUMERIC_OPERATORS);
      return numberValue("ORDER_LINE_COUNT", value, true);
    },
  },
  TIME_WINDOW: {
    operators: WINDOW_OPERATORS,
    normalize: (operator, value) => {
      assertOperator("TIME_WINDOW", operator, WINDOW_OPERATORS);
      const raw = assertPlainObject(value, "TIME_WINDOW");

      if (!Array.isArray(raw.days) || raw.days.length === 0) {
        fail("TIME_WINDOW requires at least one weekday");
      }
      const days = raw.days.map((day) => {
        if (
          typeof day !== "number" ||
          !Number.isInteger(day) ||
          day < 0 ||
          day > 6
        ) {
          fail("TIME_WINDOW weekdays must be numbers from 0 (Sunday) to 6");
        }
        return day;
      });

      const start = stringValue("TIME_WINDOW", raw.start);
      const end = stringValue("TIME_WINDOW", raw.end);
      if (!CLOCK.test(start) || !CLOCK.test(end)) {
        fail("TIME_WINDOW times must use 24-hour HH:mm");
      }
      if (start >= end) {
        fail("TIME_WINDOW must start before it ends");
      }

      return { days: [...new Set(days)].sort((a, b) => a - b), start, end };
    },
  },
};

export function normalizeCondition(
  input: ConditionValueInput,
): NormalizedCondition {
  const spec = FIELD_SPECS[input.field];
  if (!spec) {
    fail(`Unsupported condition field: ${input.field}`);
  }
  return {
    field: input.field,
    operator: input.operator,
    valueJson: spec.normalize(input.operator, input.value),
  };
}

/** Thrown at evaluation time when a stored tree no longer validates. */
export type ConditionNode = {
  field: ConditionField;
  operator: ConditionOperator;
  valueJson: unknown;
  position?: number;
};

export type ConditionGroupNode = {
  joinOp: "AND" | "OR";
  conditions?: ConditionNode[];
  children?: ConditionGroupNode[];
};

/**
 * Validates structure and caps before saving or evaluating. Empty groups are
 * rejected because they would otherwise silently evaluate as unconstrained.
 */
export function validateConditionTree(roots: ConditionGroupNode[]): void {
  let groupCount = 0;
  let conditionCount = 0;

  const walk = (group: ConditionGroupNode, depth: number): void => {
    if (depth > CONDITION_LIMITS.maxDepth) {
      fail(`Conditions support at most ${CONDITION_LIMITS.maxDepth} levels`);
    }
    groupCount += 1;

    const conditions = group.conditions ?? [];
    const children = group.children ?? [];
    if (conditions.length === 0 && children.length === 0) {
      fail("Condition groups cannot be empty");
    }

    for (const condition of conditions) {
      normalizeCondition({
        field: condition.field,
        operator: condition.operator,
        value: condition.valueJson,
      });
      conditionCount += 1;
    }

    for (const child of children) {
      walk(child, depth + 1);
    }
  };

  for (const root of roots) {
    walk(root, 1);
  }

  if (groupCount > CONDITION_LIMITS.maxGroups) {
    fail(`A rule can have at most ${CONDITION_LIMITS.maxGroups} condition groups`);
  }
  if (conditionCount > CONDITION_LIMITS.maxConditions) {
    fail(
      `A rule can have at most ${CONDITION_LIMITS.maxConditions} conditions`,
    );
  }
}

const EXPERIENCE_SUPPORT: Record<Experience, ConditionField[]> = {
  PRE_PURCHASE: [
    "CART_SUBTOTAL",
    "CART_LINE_COUNT",
    "CART_TOTAL_QUANTITY",
    "CART_CONTAINS_PRODUCT",
    "CART_QUANTITY_OF_PRODUCT",
    "CUSTOMER_LOGGED_IN",
    "SHIPPING_COUNTRY",
    "MARKET_COUNTRY",
    "TIME_WINDOW",
  ],
  POST_PURCHASE: [
    "CUSTOMER_LOGGED_IN",
    "SHIPPING_COUNTRY",
    "MARKET_COUNTRY",
    "ORDER_TOTAL",
    "ORDER_LINE_COUNT",
    "TIME_WINDOW",
  ],
};

/**
 * Conditions a product or cart page can evaluate. The storefront knows the
 * cart lines, its subtotal and whether a customer is signed in; it does not
 * know the shipping or market country before checkout, so those are excluded
 * rather than silently evaluated as unknown.
 */
export const STOREFRONT_CONDITION_FIELDS: readonly ConditionField[] = [
  "CART_SUBTOTAL",
  "CART_LINE_COUNT",
  "CART_TOTAL_QUANTITY",
  "CART_CONTAINS_PRODUCT",
  "CART_QUANTITY_OF_PRODUCT",
  "CUSTOMER_LOGGED_IN",
  "TIME_WINDOW",
];

export function isStorefrontConditionSupported(field: ConditionField): boolean {
  return STOREFRONT_CONDITION_FIELDS.includes(field);
}

export function isConditionSupported(
  experience: Experience,
  field: ConditionField,
): boolean {
  return EXPERIENCE_SUPPORT[experience].includes(field);
}

/** Rejects unsupported fields at save; never silently drops them. */
export function assertConditionsSupported(
  experience: Experience,
  fields: ConditionField[],
): void {
  for (const field of fields) {
    if (!isConditionSupported(experience, field)) {
      fail(`${field} is not available for ${experience}`);
    }
  }
}

/** Confirms the identifier is accepted by the runtime ICU database. */
export function assertValidIanaTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    fail(`${value} is not a recognized IANA time zone`);
  }
}
