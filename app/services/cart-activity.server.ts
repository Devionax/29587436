import type { CartActivityType, Prisma } from "@prisma/client";
import db from "../db.server";
import { logger } from "../utils/logger.server";
import { isProductGid, isVariantGid } from "../utils/gid";

/**
 * Cart activity for the automatic offer sources.
 *
 * Shopify does not send a previous cart state with carts/update, so the last
 * seen lines per cart token are cached in CartWatch and diffed. Cart tokens are
 * pseudonymous (they are not customer identifiers) and are also used as the
 * session key for the recently-removed source.
 */

const MAX_LINES = 100;
const MAX_TOKEN = 255;
const MAX_ACTIVITY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredCartLine = {
  productGid: string;
  variantGid: string;
  quantity: number;
};

export type CartSnapshot = {
  cartToken: string;
  lines: StoredCartLine[];
  occurredAt: Date;
};

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 999 ? parsed : null;
}

function gidNumber(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "string") return String(value);
  return null;
}

/** Reads only the fields the automatic sources need from a carts webhook. */
export function cartSnapshotFromWebhook(
  payload: Record<string, unknown>,
): CartSnapshot | null {
  const cartToken = payload.token;
  if (typeof cartToken !== "string" || cartToken.length === 0) return null;
  if (cartToken.length > MAX_TOKEN) return null;

  const rawLines = payload.line_items;
  if (!Array.isArray(rawLines)) return null;

  const lines: StoredCartLine[] = [];
  const seen = new Set<string>();

  for (const item of rawLines.slice(0, MAX_LINES)) {
    if (!item || typeof item !== "object") continue;
    const line = item as Record<string, unknown>;

    const productId = gidNumber(line.product_id);
    const variantId = gidNumber(line.variant_id);
    const quantity = positiveInteger(line.quantity);
    if (!productId || !variantId || !quantity) continue;

    const productGid = `gid://shopify/Product/${productId}`;
    const variantGid = `gid://shopify/ProductVariant/${variantId}`;
    if (!isProductGid(productGid) || !isVariantGid(variantGid)) continue;
    if (seen.has(variantGid)) continue;

    seen.add(variantGid);
    lines.push({ productGid, variantGid, quantity });
  }

  const updatedAt = payload.updated_at;
  const parsed = typeof updatedAt === "string" ? new Date(updatedAt) : null;
  const now = new Date();
  const occurredAt =
    parsed && !Number.isNaN(parsed.getTime()) && now.getTime() - parsed.getTime() <= MAX_ACTIVITY_AGE_MS
      ? parsed
      : now;

  return { cartToken, lines, occurredAt };
}

function storedLines(value: Prisma.JsonValue): StoredCartLine[] {
  if (!Array.isArray(value)) return [];
  const lines: StoredCartLine[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const productGid = record.productGid;
    const variantGid = record.variantGid;
    const quantity = positiveInteger(record.quantity);
    if (
      typeof productGid === "string" &&
      isProductGid(productGid) &&
      typeof variantGid === "string" &&
      isVariantGid(variantGid) &&
      quantity
    ) {
      lines.push({ productGid, variantGid, quantity });
    }
  }
  return lines;
}

export type CartActivityEvent = {
  productGid: string;
  variantGid: string;
  activityType: CartActivityType;
};

function diffLines(
  previous: StoredCartLine[],
  next: StoredCartLine[],
): CartActivityEvent[] {
  const previousByVariant = new Map(previous.map((line) => [line.variantGid, line]));
  const nextByVariant = new Map(next.map((line) => [line.variantGid, line]));
  const events: CartActivityEvent[] = [];

  for (const line of next) {
    const before = previousByVariant.get(line.variantGid);
    if (!before) {
      events.push({ ...line, activityType: "ADDED" });
      continue;
    }
    if (line.quantity > before.quantity) {
      events.push({ ...line, activityType: "ADDED" });
    } else if (line.quantity < before.quantity) {
      events.push({ ...line, activityType: "REMOVED" });
    }
  }

  for (const line of previous) {
    if (!nextByVariant.has(line.variantGid)) {
      events.push({ ...line, activityType: "REMOVED" });
    }
  }

  return events;
}

/** Applies a carts webhook to CartActivity + CartWatch for an installed shop. */
export async function recordCartSnapshot(
  shopId: string,
  snapshot: CartSnapshot,
): Promise<CartActivityEvent[]> {
  const existing = await db.cartWatch.findUnique({
    where: { cartToken: snapshot.cartToken },
  });

  // A cart token belongs to exactly one shop. If the row exists under another
  // tenant, skip rather than take it over.
  if (existing && existing.shopId !== shopId) {
    logger.warn("Cart token collision across shops ignored", {
      cartToken: snapshot.cartToken,
    });
    return [];
  }

  const events = diffLines(
    existing ? storedLines(existing.lines) : [],
    snapshot.lines,
  );

  if (events.length > 0) {
    await db.cartActivity.createMany({
      data: events.map((event) => ({
        shopId,
        sessionKey: snapshot.cartToken,
        productGid: event.productGid,
        variantGid: event.variantGid,
        activityType: event.activityType,
        occurredAt: snapshot.occurredAt,
      })),
    });
  }

  const lines = snapshot.lines as unknown as Prisma.InputJsonValue;

  await db.cartWatch.upsert({
    where: { cartToken: snapshot.cartToken },
    create: {
      cartToken: snapshot.cartToken,
      shopId,
      sessionKey: snapshot.cartToken,
      lines,
    },
    update: { lines, sessionKey: snapshot.cartToken },
  });

  return events;
}

export type ActivityRow = {
  sessionKey: string;
  productGid: string;
  variantGid: string;
  activityType: CartActivityType;
  occurredAt: Date;
};

const MAX_ACTIVITY_ROWS = 5000;
const MAX_LOOKBACK_HOURS = 2160;

/**
 * Loads one bounded slice of activity covering the widest lookback any active
 * rule asks for. Callers filter per rule in memory.
 */
export async function loadRecentActivity(
  shopId: string,
  lookbackHours: number,
): Promise<ActivityRow[]> {
  const hours = Math.min(
    Math.max(Number.isFinite(lookbackHours) ? lookbackHours : 168, 1),
    MAX_LOOKBACK_HOURS,
  );
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  return db.cartActivity.findMany({
    where: { shopId, occurredAt: { gte: since } },
    orderBy: { occurredAt: "desc" },
    take: MAX_ACTIVITY_ROWS,
    select: {
      sessionKey: true,
      productGid: true,
      variantGid: true,
      activityType: true,
      occurredAt: true,
    },
  });
}
