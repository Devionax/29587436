/**
 * Thrown when a record exists but does not belong to the authenticated shop.
 * Callers must never reveal whether the record exists for another tenant.
 */
export class TenantResourceNotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} was not found`);
    this.name = "TenantResourceNotFoundError";
  }
}

/**
 * Thrown when a write input contains data the API refuses to accept,
 * such as duplicate variants in one rule.
 */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/**
 * Thrown when an action would exceed the shop's plan limits. The message is
 * safe to show to the merchant.
 */
export class PlanLimitError extends Error {
  readonly limit: "RULES" | "ACTIVE_RULES" | "OFFERS";

  constructor(limit: PlanLimitError["limit"], message: string) {
    super(message);
    this.name = "PlanLimitError";
    this.limit = limit;
  }
}
