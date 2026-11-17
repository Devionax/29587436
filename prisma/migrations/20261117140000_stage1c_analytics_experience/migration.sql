-- Stage 1C: analytics dimensions for checkout experiences.
-- Additive only. Existing rows keep NULL experience / declineReason and are
-- treated as legacy; no data is rewritten or removed.

-- AlterEnum
ALTER TYPE "AnalyticsEventType" ADD VALUE 'OFFER_ACCEPTED';
ALTER TYPE "AnalyticsEventType" ADD VALUE 'OFFER_DECLINED';

-- CreateEnum
CREATE TYPE "DeclineReason" AS ENUM ('OUT_OF_STOCK', 'VARIANT_UNAVAILABLE', 'CART_LIMIT', 'NETWORK', 'UNKNOWN');

-- AlterTable
ALTER TABLE "AnalyticsEvent" ADD COLUMN "experience" "Experience";
ALTER TABLE "AnalyticsEvent" ADD COLUMN "declineReason" "DeclineReason";

-- AlterTable
ALTER TABLE "OrderAttribution" ADD COLUMN "experience" "Experience";

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shopId_experience_occurredAt_idx" ON "AnalyticsEvent"("shopId", "experience", "occurredAt");
