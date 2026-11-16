-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MatchMode" AS ENUM ('ANY', 'ALL');

-- CreateEnum
CREATE TYPE "Surface" AS ENUM ('PRODUCT_PAGE', 'CART_PAGE', 'CHECKOUT');

-- CreateEnum
CREATE TYPE "AnalyticsEventType" AS ENUM ('IMPRESSION', 'CLICK', 'ADD_ATTEMPT', 'ADD_SUCCESS', 'ADD_FAILURE', 'ORDER_ATTRIBUTED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "RecommendationRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "matchMode" "MatchMode" NOT NULL DEFAULT 'ANY',
    "heading" TEXT,
    "maxOffers" INTEGER,
    "showOnProductPage" BOOLEAN NOT NULL DEFAULT true,
    "showOnCartPage" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriggerProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendedProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "defaultQuantity" INTEGER NOT NULL DEFAULT 1,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "maxQuantity" INTEGER NOT NULL DEFAULT 10,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "imageUrl" TEXT,
    "status" TEXT NOT NULL,
    "availableForSale" BOOLEAN NOT NULL DEFAULT false,
    "priceMin" DECIMAL(12,2),
    "priceMax" DECIMAL(12,2),
    "currencyCode" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariantSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "compareAtPrice" DECIMAL(12,2),
    "availableForSale" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariantSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT,
    "eventType" "AnalyticsEventType" NOT NULL,
    "surface" "Surface" NOT NULL,
    "offerProductGid" TEXT NOT NULL,
    "offerVariantGid" TEXT,
    "sessionKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAttribution" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "ruleId" TEXT,
    "offerProductGid" TEXT NOT NULL,
    "offerVariantGid" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "orderSubtotal" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "shopifySubscriptionGid" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopId" TEXT,
    "topic" TEXT NOT NULL,
    "apiVersion" TEXT,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecommendationRule_shopId_status_priority_idx" ON "RecommendationRule"("shopId", "status", "priority");

-- CreateIndex
CREATE INDEX "RecommendationRule_shopId_updatedAt_idx" ON "RecommendationRule"("shopId", "updatedAt");

-- CreateIndex
CREATE INDEX "TriggerProduct_shopId_productGid_idx" ON "TriggerProduct"("shopId", "productGid");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerProduct_ruleId_productGid_variantGid_key" ON "TriggerProduct"("ruleId", "productGid", "variantGid");

-- CreateIndex
CREATE INDEX "RecommendedProduct_shopId_ruleId_idx" ON "RecommendedProduct"("shopId", "ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendedProduct_ruleId_variantGid_key" ON "RecommendedProduct"("ruleId", "variantGid");

-- CreateIndex
CREATE INDEX "ProductSnapshot_shopId_syncedAt_idx" ON "ProductSnapshot"("shopId", "syncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSnapshot_shopId_productGid_key" ON "ProductSnapshot"("shopId", "productGid");

-- CreateIndex
CREATE INDEX "ProductVariantSnapshot_productId_idx" ON "ProductVariantSnapshot"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariantSnapshot_shopId_variantGid_key" ON "ProductVariantSnapshot"("shopId", "variantGid");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsEvent_dedupeKey_key" ON "AnalyticsEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shopId_occurredAt_idx" ON "AnalyticsEvent"("shopId", "occurredAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shopId_ruleId_eventType_idx" ON "AnalyticsEvent"("shopId", "ruleId", "eventType");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shopId_offerProductGid_idx" ON "AnalyticsEvent"("shopId", "offerProductGid");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAttribution_orderGid_key" ON "OrderAttribution"("orderGid");

-- CreateIndex
CREATE INDEX "OrderAttribution_shopId_attributedAt_idx" ON "OrderAttribution"("shopId", "attributedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_shopId_key" ON "Subscription"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_webhookId_key" ON "WebhookReceipt"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_shopDomain_topic_idx" ON "WebhookReceipt"("shopDomain", "topic");

-- CreateIndex
CREATE INDEX "WebhookReceipt_status_idx" ON "WebhookReceipt"("status");

-- AddForeignKey
ALTER TABLE "RecommendationRule" ADD CONSTRAINT "RecommendationRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerProduct" ADD CONSTRAINT "TriggerProduct_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecommendationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendedProduct" ADD CONSTRAINT "RecommendedProduct_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecommendationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSnapshot" ADD CONSTRAINT "ProductSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantSnapshot" ADD CONSTRAINT "ProductVariantSnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ProductSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecommendationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAttribution" ADD CONSTRAINT "OrderAttribution_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAttribution" ADD CONSTRAINT "OrderAttribution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecommendationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "WebhookReceipt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
