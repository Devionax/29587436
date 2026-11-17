import type { ConditionField, ConditionOperator } from "@prisma/client";
import type {
  ConditionGroupNode,
  ConditionNode,
} from "./condition-schema";

/**
 * Pure tri-state evaluator for depth-2 condition trees.
 *
 * `null` means unknown: the data needed to decide is missing or unsupported.
 * Unknown never matches. The caller must preload `ConditionContext`; this
 * module performs no I/O.
 */

export type TriState = true | false | null;

export type CartLine = {
  productGid: string;
  variantGid?: string | null;
  quantity: number;
};

export type ConditionContext = {
  cart?: {
    subtotal?: number | null;
    lines?: CartLine[] | null;
  } | null;
  customer?: { loggedIn?: boolean | null } | null;
  shippingCountry?: string | null;
  marketCountry?: string | null;
  order?: {
    total?: number | null;
    lineCount?: number | null;
  } | null;
  /** IANA identifier; null or missing makes time windows unknown. */
  timeZone?: string | null;
  /** Injected for deterministic tests; defaults to the current instant. */
  now?: Date;
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function andAll(values: TriState[]): TriState {
  if (values.includes(false)) return false;
  if (values.includes(null)) return null;
  return true;
}

function orAll(values: TriState[]): TriState {
  if (values.includes(true)) return true;
  if (values.includes(null)) return null;
  return false;
}

function compare(
  actual: number | null | undefined,
  operator: ConditionOperator,
  expected: number,
): TriState {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) {
    return null;
  }
  switch (operator) {
    case "EQ":
      return actual === expected;
    case "NEQ":
      return actual !== expected;
    case "GT":
      return actual > expected;
    case "GTE":
      return actual >= expected;
    case "LT":
      return actual < expected;
    case "LTE":
      return actual <= expected;
    default:
      return null;
  }
}

function normalizedCountry(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().toUpperCase();
}

function cartLines(context: ConditionContext): CartLine[] | null {
  return context.cart?.lines ?? null;
}

function quantityOfProduct(lines: CartLine[], productGid: string): number {
  return lines.reduce((total, line) => {
    return line.productGid === productGid ? total + line.quantity : total;
  }, 0);
}

function windowResult(
  condition: ConditionNode,
  context: ConditionContext,
): TriState {
  const timeZone = context.timeZone;
  if (!timeZone) return null;

  const value = condition.valueJson as
    | { days?: unknown; start?: unknown; end?: unknown }
    | null;
  if (!value || !Array.isArray(value.days)) return null;
  if (typeof value.start !== "string" || typeof value.end !== "string") {
    return null;
  }

  const start = clockMinutes(value.start);
  const end = clockMinutes(value.end);
  if (start === null || end === null || start >= end) return null;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(context.now ?? new Date());
  } catch {
    // Invalid identifier stored out of band: fail closed.
    return null;
  }

  const weekdayName = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const weekday = weekdayName ? WEEKDAYS[weekdayName] : undefined;
  if (
    weekday === undefined ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    return null;
  }

  const minutes = hour * 60 + minute;
  const inside = value.days.includes(weekday) && minutes >= start && minutes < end;
  return condition.operator === "NOT_IN" ? !inside : inside;
}

function clockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function evaluateCondition(
  condition: ConditionNode,
  context: ConditionContext,
): TriState {
  const field: ConditionField = condition.field;
  const operator = condition.operator;

  switch (field) {
    case "CART_SUBTOTAL":
      return compare(context.cart?.subtotal, operator, condition.valueJson as number);
    case "CART_LINE_COUNT": {
      const lines = cartLines(context);
      return compare(lines?.length, operator, condition.valueJson as number);
    }
    case "CART_TOTAL_QUANTITY": {
      const lines = cartLines(context);
      if (lines === null) return null;
      const total = lines.reduce((sum, line) => sum + line.quantity, 0);
      return compare(total, operator, condition.valueJson as number);
    }
    case "ORDER_TOTAL":
      return compare(context.order?.total, operator, condition.valueJson as number);
    case "ORDER_LINE_COUNT":
      return compare(
        context.order?.lineCount,
        operator,
        condition.valueJson as number,
      );
    case "CART_CONTAINS_PRODUCT": {
      const lines = cartLines(context);
      if (lines === null) return null;
      const gids = condition.valueJson as string[];
      const contains = lines.some((line) => gids.includes(line.productGid));
      return operator === "NOT_IN" ? !contains : contains;
    }
    case "CART_QUANTITY_OF_PRODUCT": {
      const lines = cartLines(context);
      if (lines === null) return null;
      const value = condition.valueJson as {
        productGid: string;
        quantity: number;
      };
      return compare(
        quantityOfProduct(lines, value.productGid),
        operator,
        value.quantity,
      );
    }
    case "CUSTOMER_LOGGED_IN": {
      const loggedIn = context.customer?.loggedIn;
      if (loggedIn === null || loggedIn === undefined) return null;
      return operator === "NEQ"
        ? loggedIn !== condition.valueJson
        : loggedIn === condition.valueJson;
    }
    case "SHIPPING_COUNTRY":
    case "MARKET_COUNTRY": {
      const actual = normalizedCountry(
        field === "SHIPPING_COUNTRY"
          ? context.shippingCountry
          : context.marketCountry,
      );
      if (actual === null) return null;
      const expected = condition.valueJson;
      if (operator === "IN" || operator === "NOT_IN") {
        const codes = expected as string[];
        const included = codes.includes(actual);
        return operator === "NOT_IN" ? !included : included;
      }
      return operator === "NEQ" ? actual !== expected : actual === expected;
    }
    case "TIME_WINDOW":
      return windowResult(condition, context);
    default:
      return null;
  }
}

function evaluateGroup(
  group: ConditionGroupNode,
  context: ConditionContext,
): TriState {
  const results: TriState[] = [
    ...(group.conditions ?? []).map((condition) =>
      evaluateCondition(condition, context),
    ),
    ...(group.children ?? []).map((child) => evaluateGroup(child, context)),
  ];
  return group.joinOp === "OR" ? orAll(results) : andAll(results);
}

/**
 * Root groups are combined with AND. No groups means the rule has no condition
 * constraint and evaluates true; unknown anywhere in the final result prevents
 * a match.
 */
export function evaluateConditionTree(
  roots: ConditionGroupNode[],
  context: ConditionContext,
): TriState {
  if (roots.length === 0) return true;
  return andAll(roots.map((root) => evaluateGroup(root, context)));
}

export function conditionsMatch(
  roots: ConditionGroupNode[],
  context: ConditionContext,
): boolean {
  return evaluateConditionTree(roots, context) === true;
}
