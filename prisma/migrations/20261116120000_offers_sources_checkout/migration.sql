-- Additive Phase 1 migration: offer sources, automatic-source settings, and
-- cart activity tracking. No table or column is renamed or dropped; existing
-- rules keep their behavior and receive safe defaults.

-- CreateEnum
CREATE TYPE "OfferSource" AS ENUM ('MANUAL', 'RECENTLY_REMOVED', 'REPEATED_ACTIVITY');

-- CreateEnum
CREATE TYPE "CartActivityType" AS ENUM ('ADDED', 'REMOVED');

-- AlterTable
ALTER TABLE "RecommendationRule" ADD COLUMN     "autoLookbackHours" INTEGER NOT NULL DEFAULT 168,
ADD COLUMN     "autoMaxOffers" INTEGER,
ADD COLUMN     "autoMinRepeats" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "prioritizeRepeats" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showOnCheckout" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sources" "OfferSource"[] DEFAULT ARRAY['MANUAL']::"OfferSource"[],
ADD COLUMN     "startsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CartActivity" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "activityType" "CartActivityType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartWatch" (
    "cartToken" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sessionKey" TEXT,
    "lines" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartWatch_pkey" PRIMARY KEY ("cartToken")
);

-- CreateIndex
CREATE INDEX "CartActivity_shopId_sessionKey_occurredAt_idx" ON "CartActivity"("shopId", "sessionKey", "occurredAt");

-- CreateIndex
CREATE INDEX "CartActivity_shopId_productGid_occurredAt_idx" ON "CartActivity"("shopId", "productGid", "occurredAt");

-- CreateIndex
CREATE INDEX "CartActivity_shopId_activityType_occurredAt_idx" ON "CartActivity"("shopId", "activityType", "occurredAt");

-- CreateIndex
CREATE INDEX "CartWatch_shopId_updatedAt_idx" ON "CartWatch"("shopId", "updatedAt");

-- AddForeignKey
ALTER TABLE "CartActivity" ADD CONSTRAINT "CartActivity_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartWatch" ADD CONSTRAINT "CartWatch_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
