import type { DeclineReason, Experience, Surface } from "@prisma/client";

/**
 * Checkout event payloads are untrusted. Only the event type, surface,
 * experience, decline reason and a pseudonymous session key are taken from the
 * client; rule, product and variant identifiers are resolved server-side from
 * the offer id, so a forged payload cannot create analytics for another shop's
 * offer.
 */

export const MAX_EVENTS_PER_REQUEST = 20;

export type IncomingEventType =
  | "IMPRESSION"
  | "CLICK"
  | "ADD_ATTEMPT"
  | "ADD_SUCCESS"
  | "ADD_FAILURE"
  | "OFFER_ACCEPTED"
  | "OFFER_DECLINED";

const EVENT_TYPES: readonly IncomingEventType[] = [
  "IMPRESSION",
  "CLICK",
  "ADD_ATTEMPT",
  "ADD_SUCCESS",
  "ADD_FAILURE",
  "OFFER_ACCEPTED",
  "OFFER_DECLINED",
];

/**
 * Legacy theme events keep using their own surfaces; checkout extensions send
 * CHECKOUT. ORDER_ATTRIBUTED is derived server-side and never accepted.
 */
const SURFACES: readonly Surface[] = ["PRODUCT_PAGE", "CART_PAGE", "CHECKOUT"];

const EXPERIENCES: readonly Experience[] = ["PRE_PURCHASE", "POST_PURCHASE"];

const DECLINE_REASONS: readonly DeclineReason[] = [
  "OUT_OF_STOCK",
  "VARIANT_UNAVAILABLE",
  "CART_LIMIT",
  "NETWORK",
  "UNKNOWN",
];

const OFFER_ID = /^[A-Za-z0-9:_-]{10,120}$/;
const SESSION_KEY = /^[A-Za-z0-9_-]{8,80}$/;
const DEDUPE_KEY = /^[A-Za-z0-9_:./-]{1,120}$/;

export type IncomingEvent = {
  eventType: IncomingEventType;
  surface: Surface;
  /** Null for legacy product/cart events written before experiences existed. */
  experience: Experience | null;
  /** Set only for failed adds and declined offers. */
  declineReason: DeclineReason | null;
  offerId: string;
  sessionKey: string;
  dedupeKey: string;
};

function parseEventSurface(raw: unknown): Surface | null {
  if (raw === "product") return "PRODUCT_PAGE";
  if (raw === "cart") return "CART_PAGE";
  if (raw === "checkout") return "CHECKOUT";
  return null;
}

function eventList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const events = (raw as Record<string, unknown>).events;
    if (Array.isArray(events)) return events;
    return [raw];
  }
  return [];
}

function parseExperience(
  surface: Surface,
  raw: unknown,
): Experience | null | "invalid" {
  if (raw === undefined || raw === null || raw === "") {
    // Checkout events always belong to an experience; anything else may be legacy.
    return surface === "CHECKOUT" ? "invalid" : null;
  }
  if (typeof raw !== "string" || !EXPERIENCES.includes(raw as Experience)) {
    return "invalid";
  }
  return raw as Experience;
}

function parseDeclineReason(
  eventType: IncomingEventType,
  raw: unknown,
): DeclineReason | null | "invalid" {
  const expectsReason =
    eventType === "ADD_FAILURE" || eventType === "OFFER_DECLINED";

  if (raw === undefined || raw === null || raw === "") {
    return expectsReason ? "UNKNOWN" : null;
  }
  if (typeof raw !== "string" || !DECLINE_REASONS.includes(raw as DeclineReason)) {
    return "invalid";
  }
  return expectsReason ? (raw as DeclineReason) : null;
}

function parseEvent(item: unknown): IncomingEvent | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;

  const eventType = record.eventType;
  if (
    typeof eventType !== "string" ||
    !EVENT_TYPES.includes(eventType as IncomingEventType)
  ) {
    return null;
  }

  const surface = parseEventSurface(record.surface);
  if (!surface || !SURFACES.includes(surface)) return null;

  const experience = parseExperience(surface, record.experience);
  if (experience === "invalid") return null;

  const declineReason = parseDeclineReason(
    eventType as IncomingEventType,
    record.declineReason,
  );
  if (declineReason === "invalid") return null;

  const offerId = record.offerId;
  if (typeof offerId !== "string" || !OFFER_ID.test(offerId)) return null;

  const sessionKey = record.sessionKey;
  if (typeof sessionKey !== "string" || !SESSION_KEY.test(sessionKey)) return null;

  const rawDedupe = record.dedupeKey;
  const dedupeKey =
    typeof rawDedupe === "string" && DEDUPE_KEY.test(rawDedupe)
      ? rawDedupe
      : `${sessionKey}:${eventType}:${offerId}`;

  return {
    eventType: eventType as IncomingEventType,
    surface,
    experience,
    declineReason,
    offerId,
    sessionKey,
    dedupeKey,
  };
}

/** Returns at most `MAX_EVENTS_PER_REQUEST` well-formed events. */
export function parseStorefrontEventBatch(raw: unknown): IncomingEvent[] {
  const events: IncomingEvent[] = [];

  for (const item of eventList(raw).slice(0, MAX_EVENTS_PER_REQUEST)) {
    const event = parseEvent(item);
    if (event) events.push(event);
  }

  return events;
}
