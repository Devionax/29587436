import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import {
  cartSnapshotFromWebhook,
  recordCartSnapshot,
} from "../../app/services/cart-activity.server";
import { createShop, prisma } from "../helpers/db";

describe("cart activity storage", () => {
  let shopA: Awaited<ReturnType<typeof createShop>>;
  let shopB: Awaited<ReturnType<typeof createShop>>;

  beforeAll(async () => {
    shopA = await createShop("cart-a");
    shopB = await createShop("cart-b");
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({
      where: { id: { in: [shopA.id, shopB.id] } },
    });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("records add and remove events in time order per session", async () => {
    const earlier = new Date("2026-11-16T10:00:00Z");
    const later = new Date("2026-11-16T10:05:00Z");

    await prisma.cartActivity.createMany({
      data: [
        {
          shopId: shopA.id,
          sessionKey: "session-a",
          productGid: "gid://shopify/Product/1",
          variantGid: "gid://shopify/ProductVariant/11",
          activityType: "ADDED",
          occurredAt: earlier,
        },
        {
          shopId: shopA.id,
          sessionKey: "session-a",
          productGid: "gid://shopify/Product/1",
          variantGid: "gid://shopify/ProductVariant/11",
          activityType: "REMOVED",
          occurredAt: later,
        },
      ],
    });

    const events = await prisma.cartActivity.findMany({
      where: { shopId: shopA.id, sessionKey: "session-a" },
      orderBy: { occurredAt: "asc" },
    });

    expect(events.map((event) => event.activityType)).toEqual([
      "ADDED",
      "REMOVED",
    ]);
  });

  it("separates identical session keys across tenants", async () => {
    await prisma.cartActivity.create({
      data: {
        shopId: shopB.id,
        sessionKey: "session-a",
        productGid: "gid://shopify/Product/1",
        variantGid: "gid://shopify/ProductVariant/11",
        activityType: "ADDED",
        occurredAt: new Date(),
      },
    });

    expect(
      await prisma.cartActivity.count({
        where: { shopId: shopA.id, sessionKey: "session-a" },
      }),
    ).toBe(2);
    expect(
      await prisma.cartActivity.count({
        where: { shopId: shopB.id, sessionKey: "session-a" },
      }),
    ).toBe(1);
  });

  it("stores the last known cart lines per cart token", async () => {
    const cartToken = `cart-${shopA.id}`;

    await prisma.cartWatch.create({
      data: {
        cartToken,
        shopId: shopA.id,
        sessionKey: "session-a",
        lines: [
          {
            productGid: "gid://shopify/Product/1",
            variantGid: "gid://shopify/ProductVariant/11",
            quantity: 1,
          },
        ],
      },
    });

    await prisma.cartWatch.update({
      where: { cartToken },
      data: {
        lines: [
          {
            productGid: "gid://shopify/Product/1",
            variantGid: "gid://shopify/ProductVariant/11",
            quantity: 3,
          },
        ],
      },
    });

    const watch = await prisma.cartWatch.findFirstOrThrow({
      where: { cartToken, shopId: shopA.id },
    });
    expect(watch.lines).toEqual([
      {
        productGid: "gid://shopify/Product/1",
        variantGid: "gid://shopify/ProductVariant/11",
        quantity: 3,
      },
    ]);

    expect(
      await prisma.cartWatch.count({ where: { shopId: shopB.id } }),
    ).toBe(0);
  });

  it("cascades cart activity and watches when a shop is deleted", async () => {
    const shopC = await createShop("cart-cascade");
    const cartToken = `cart-${shopC.id}`;

    await prisma.cartActivity.create({
      data: {
        shopId: shopC.id,
        sessionKey: "session-c",
        productGid: "gid://shopify/Product/3",
        variantGid: "gid://shopify/ProductVariant/33",
        activityType: "REMOVED",
        occurredAt: new Date(),
      },
    });
    await prisma.cartWatch.create({
      data: { cartToken, shopId: shopC.id, lines: [] },
    });

    await prisma.shop.delete({ where: { id: shopC.id } });

    expect(
      await prisma.cartActivity.count({ where: { shopId: shopC.id } }),
    ).toBe(0);
    expect(await prisma.cartWatch.count({ where: { cartToken } })).toBe(0);
  });

  it("reads only the fields carts webhooks provide", () => {
    const snapshot = cartSnapshotFromWebhook({
      token: "webhook-token",
      updated_at: new Date().toISOString(),
      customer: { email: "buyer@example.com" },
      line_items: [
        { product_id: 701, variant_id: 70101, quantity: 2 },
        { product_id: 701, variant_id: 70101, quantity: 5 },
        { product_id: 702, variant_id: 70201, quantity: 0 },
        { product_id: "bad", variant_id: 70201, quantity: 1 },
      ],
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.lines).toEqual([
      {
        productGid: "gid://shopify/Product/701",
        variantGid: "gid://shopify/ProductVariant/70101",
        quantity: 2,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("buyer@example.com");

    expect(cartSnapshotFromWebhook({ line_items: [] })).toBeNull();
    expect(cartSnapshotFromWebhook({ token: "x", line_items: "nope" })).toBeNull();
  });

  it("diffs successive carts into add and remove activity", async () => {
    const cartToken = `webhook-${shopA.id}`;

    const first = cartSnapshotFromWebhook({
      token: cartToken,
      updated_at: new Date().toISOString(),
      line_items: [
        { product_id: 801, variant_id: 80101, quantity: 1 },
        { product_id: 802, variant_id: 80201, quantity: 1 },
      ],
    });
    expect(await recordCartSnapshot(shopA.id, first!)).toHaveLength(2);

    // The same cart state again produces no duplicate activity.
    expect(await recordCartSnapshot(shopA.id, first!)).toHaveLength(0);

    const next = cartSnapshotFromWebhook({
      token: cartToken,
      updated_at: new Date().toISOString(),
      line_items: [
        { product_id: 801, variant_id: 80101, quantity: 3 },
        { product_id: 803, variant_id: 80301, quantity: 1 },
      ],
    });
    expect(await recordCartSnapshot(shopA.id, next!)).toHaveLength(3);

    const events = await prisma.cartActivity.findMany({
      where: { shopId: shopA.id, sessionKey: cartToken },
      orderBy: { occurredAt: "asc" },
    });
    expect(
      events.map((event) => `${event.variantGid}:${event.activityType}`).sort(),
    ).toEqual(
      [
        "gid://shopify/ProductVariant/80101:ADDED",
        "gid://shopify/ProductVariant/80101:ADDED",
        "gid://shopify/ProductVariant/80201:ADDED",
        "gid://shopify/ProductVariant/80201:REMOVED",
        "gid://shopify/ProductVariant/80301:ADDED",
      ].sort(),
    );

    // A token already owned by shop A cannot be taken over by shop B.
    expect(await recordCartSnapshot(shopB.id, next!)).toHaveLength(0);
    expect(
      await prisma.cartActivity.count({
        where: { shopId: shopB.id, sessionKey: cartToken },
      }),
    ).toBe(0);
  });
});
