-- Stage 1A: per-experience offer configuration.
-- Additive only. No existing row is updated or deleted; the backfill inserts
-- PRE_PURCHASE rows for rules that already opted into checkout.

-- CreateEnum
CREATE TYPE "Experience" AS ENUM ('PRE_PURCHASE', 'POST_PURCHASE');

-- CreateTable
CREATE TABLE "OfferExperience" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "experience" "Experience" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "headline" TEXT,
    "body" TEXT,
    "ctaLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferExperience_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OfferExperience_ruleId_experience_key" ON "OfferExperience"("ruleId", "experience");

-- CreateIndex
CREATE INDEX "OfferExperience_shopId_experience_enabled_idx" ON "OfferExperience"("shopId", "experience", "enabled");

-- AddForeignKey
ALTER TABLE "OfferExperience" ADD CONSTRAINT "OfferExperience_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferExperience" ADD CONSTRAINT "OfferExperience_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecommendationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: rules that already opted into checkout get an enabled pre-purchase
-- experience. Deterministic ids keep a re-run idempotent; ON CONFLICT guards the
-- unique key.
INSERT INTO "OfferExperience" ("id", "shopId", "ruleId", "experience", "enabled", "createdAt", "updatedAt")
SELECT
    'oe_pre_' || md5(r."id"),
    r."shopId",
    r."id",
    'PRE_PURCHASE'::"Experience",
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "RecommendationRule" r
WHERE r."showOnCheckout" = true
ON CONFLICT ("ruleId", "experience") DO NOTHING;
