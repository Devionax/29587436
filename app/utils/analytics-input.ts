import type { Surface } from "@prisma/client";
import { parseSurface } from "./storefront-input";

/**
 * Storefront analytics payloads are untrusted. Only the event type, surface and
 * a pseudonymous session key are taken from the client; rule, product and
 * variant identifiers are resolved server-side from the offer id, so a forged
 * payload cannot create analytics for another shop's offer.
 */

export const MAX_EVENTS_PER_REQUEST = 20;

export type IncomingEventType =
  | "IMPRESSION"
  | "ADD_ATTEMPT"
  | "ADD_SUCCESS"
  | "ADD_FAILURE";

const EVENT_TYPES: readonly IncomingEventType[] = [
  "IMPRESSION",
  "ADD_ATTEMPT",
  "ADD_SUCCESS",
  "ADD_FAILURE",
];

const SURFACES: readonly Surface[] = ["PRODUCT_PAGE", "CART_PAGE"];

const OFFER_ID = /^[a-z0-9]{10,40}$/i;
const SESSION_KEY = /^[A-Za-z0-9_-]{8,80}$/;
const DEDUPE_KEY = /^[A-Za-z0-9_:./-]{1,120}$/;

export type IncomingEvent = {
  eventType: IncomingEventType;
  surface: Surface;
  offerId: string;
  sessionKey: string;
  dedupeKey: string;
};

function eventList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const events = (raw as Record<string, unknown>).events;
    if (Array.isArray(events)) return events;
    return [raw];
  }
  return [];
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

  const surface = parseSurface(record.surface);
  if (!surface || !SURFACES.includes(surface)) return null;

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
