import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import { redactShopData } from "../../app/services/privacy.server";
import {
  beginWebhook,
  completeWebhook,
} from "../../app/services/webhook-receipts.server";
import { createRule } from "../../app/services/rules.server";
import { createShop, prisma } from "../helpers/db";

describe("webhook receipts", () => {
  let shop: Awaited<ReturnType<typeof createShop>>;
  let counter = 0;

  beforeAll(async () => {
    shop = await createShop("receipts");
  });

  afterAll(async () => {
    await prisma.webhookReceipt.deleteMany({
      where: { shopDomain: shop.shopDomain },
    });
    await prisma.shop.deleteMany({ where: { id: shop.id } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  function nextId(): string {
    counter += 1;
    return `webhook-${Date.now()}-${counter}`;
  }

  it("records a new delivery and links it to the tenant", async () => {
    const webhookId = nextId();
    const start = await beginWebhook(
      shop.shopDomain,
      "products/update",
      webhookId,
      "2026-10",
    );

    expect(start.duplicate).toBe(false);
    expect(start.receiptId).not.toBeNull();

    const receipt = await prisma.webhookReceipt.findUnique({
      where: { webhookId },
    });
    expect(receipt).toMatchObject({
      shopId: shop.id,
      topic: "products/update",
      apiVersion: "2026-10",
      status: "RECEIVED",
      attempts: 0,
    });
  });

  it("treats a processed delivery as a duplicate", async () => {
    const webhookId = nextId();
    const first = await beginWebhook(shop.shopDomain, "products/update", webhookId);
    await completeWebhook(first.receiptId);

    const second = await beginWebhook(shop.shopDomain, "products/update", webhookId);
    expect(second.duplicate).toBe(true);

    const receipt = await prisma.webhookReceipt.findUnique({
      where: { webhookId },
    });
    expect(receipt?.status).toBe("PROCESSED");
    expect(receipt?.processedAt).not.toBeNull();
  });

  it("retries a delivery that failed, incrementing attempts", async () => {
    const webhookId = nextId();
    const first = await beginWebhook(shop.shopDomain, "products/create", webhookId);
    await completeWebhook(first.receiptId, new Error("Admin API unavailable"));

    const failed = await prisma.webhookReceipt.findUnique({
      where: { webhookId },
    });
    expect(failed?.status).toBe("FAILED");
    expect(failed?.lastError).toBe("Admin API unavailable");

    const retry = await beginWebhook(shop.shopDomain, "products/create", webhookId);
    expect(retry.duplicate).toBe(false);
    expect(retry.receiptId).toBe(first.receiptId);

    const receipt = await prisma.webhookReceipt.findUnique({
      where: { webhookId },
    });
    expect(receipt?.status).toBe("RECEIVED");
    expect(receipt?.attempts).toBe(1);
  });

  it("retries a delivery interrupted mid-handler", async () => {
    const webhookId = nextId();
    const first = await beginWebhook(shop.shopDomain, "orders/create", webhookId);
    expect(first.duplicate).toBe(false);

    // No completeWebhook call: simulates a crash after the receipt was written.
    const retry = await beginWebhook(shop.shopDomain, "orders/create", webhookId);
    expect(retry.duplicate).toBe(false);
    expect(retry.receiptId).toBe(first.receiptId);
  });

  it("processes deliveries without a webhook id exactly once", async () => {
    const first = await beginWebhook(shop.shopDomain, "app/uninstalled", null);
    expect(first).toEqual({ duplicate: false, receiptId: null });
    await completeWebhook(null);
  });

  it("records receipts for shops that have no tenant row", async () => {
    const domain = `no-tenant-${Date.now()}.myshopify.com`;
    const webhookId = nextId();
    const start = await beginWebhook(domain, "shop/redact", webhookId);

    const receipt = await prisma.webhookReceipt.findUnique({
      where: { webhookId },
    });
    expect(receipt?.shopId).toBeNull();
    expect(receipt?.shopDomain).toBe(domain);

    await prisma.webhookReceipt.delete({ where: { webhookId } });
    expect(start.duplicate).toBe(false);
  });
});

describe("shop redaction", () => {
  let shop: Awaited<ReturnType<typeof createShop>>;

  beforeAll(async () => {
    shop = await createShop("redact");
    const rule = await createRule(shop.id, {
      name: "Redact me",
      status: "ACTIVE",
      priority: 10,
      matchMode: "ANY",
      triggers: [{ productGid: "gid://shopify/Product/1" }],
      offers: [
        {
          productGid: "gid://shopify/Product/2",
          variantGid: "gid://shopify/ProductVariant/22",
        },
      ],
    });

    await prisma.productSnapshot.create({
      data: {
        shopId: shop.id,
        productGid: "gid://shopify/Product/2",
        title: "Kept in snapshot",
        handle: "kept-in-snapshot",
        status: "ACTIVE",
        syncedAt: new Date(),
      },
    });
    await prisma.analyticsEvent.create({
      data: {
        shopId: shop.id,
        ruleId: rule.id,
        eventType: "IMPRESSION",
        surface: "PRODUCT_PAGE",
        offerProductGid: "gid://shopify/Product/2",
        sessionKey: "redact-session-1",
        dedupeKey: `${shop.id}:redact-1`,
        occurredAt: new Date(),
      },
    });
    await prisma.orderAttribution.create({
      data: {
        shopId: shop.id,
        orderGid: "gid://shopify/Order/777",
        offerProductGid: "gid://shopify/Product/2",
        offerVariantGid: "gid://shopify/ProductVariant/22",
        quantity: 1,
        lineSubtotal: "12.00",
        currencyCode: "USD",
      },
    });
    await prisma.session.create({
      data: {
        id: `offline_${shop.shopDomain}`,
        shop: shop.shopDomain,
        state: "state",
        accessToken: "token",
      },
    });
    await beginWebhook(shop.shopDomain, "products/update", `redact-${shop.id}`);
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: shop.id } });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("deletes every record the shop owns", async () => {
    const shopId = shop.id;
    const shopDomain = shop.shopDomain;

    await redactShopData(shopDomain);

    const counts = await Promise.all([
      prisma.shop.count({ where: { id: shopId } }),
      prisma.shopSettings.count({ where: { shopId } }),
      prisma.recommendationRule.count({ where: { shopId } }),
      prisma.triggerProduct.count({ where: { shopId } }),
      prisma.recommendedProduct.count({ where: { shopId } }),
      prisma.productSnapshot.count({ where: { shopId } }),
      prisma.analyticsEvent.count({ where: { shopId } }),
      prisma.orderAttribution.count({ where: { shopId } }),
      prisma.subscription.count({ where: { shopId } }),
      prisma.session.count({ where: { shop: shopDomain } }),
      prisma.webhookReceipt.count({ where: { shopDomain } }),
    ]);

    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("is idempotent for a repeated redact delivery", async () => {
    await expect(redactShopData(shop.shopDomain)).resolves.toBeUndefined();
  });
});
