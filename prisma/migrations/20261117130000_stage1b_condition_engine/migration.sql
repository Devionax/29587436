-- Additive Stage 1B migration: condition groups, leaf conditions, and the shop
-- timezone used by time-window conditions. No existing table or column is
-- renamed or dropped.

-- CreateEnum
CREATE TYPE "ConditionJoinOp" AS ENUM ('AND', 'OR');

-- CreateEnum
CREATE TYPE "ConditionField" AS ENUM ('CART_SUBTOTAL', 'CART_LINE_COUNT', 'CART_CONTAINS_PRODUCT', 'CART_QUANTITY_OF_PRODUCT', 'CUSTOMER_LOGGED_IN', 'SHIPPING_COUNTRY', 'MARKET_COUNTRY', 'ORDER_TOTAL', 'ORDER_LINE_COUNT', 'TIME_WINDOW');

-- CreateEnum
CREATE TYPE "ConditionOperator" AS ENUM ('EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IN', 'NOT_IN');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "ianaTimezone" TEXT;

-- CreateTable
CREATE TABLE "OfferConditionGroup" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "parentGroupId" TEXT,
    "joinOp" "ConditionJoinOp" NOT NULL DEFAULT 'AND',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferConditionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferCondition" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "field" "ConditionField" NOT NULL,
    "operator" "ConditionOperator" NOT NULL,
    "valueJson" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfferCondition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfferConditionGroup_ruleId_parentGroupId_position_idx" ON "OfferConditionGroup"("ruleId", "parentGroupId", "position");

-- CreateIndex
CREATE INDEX "OfferConditionGroup_shopId_idx" ON "OfferConditionGroup"("shopId");

-- CreateIndex
CREATE INDEX "OfferCondition_groupId_position_idx" ON "OfferCondition"("groupId", "position");

-- CreateIndex
CREATE INDEX "OfferCondition_shopId_idx" ON "OfferCondition"("shopId");

-- AddForeignKey
ALTER TABLE "OfferConditionGroup" ADD CONSTRAINT "OfferConditionGroup_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferConditionGroup" ADD CONSTRAINT "OfferConditionGroup_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecommendationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferConditionGroup" ADD CONSTRAINT "OfferConditionGroup_parentGroupId_fkey" FOREIGN KEY ("parentGroupId") REFERENCES "OfferConditionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferCondition" ADD CONSTRAINT "OfferCondition_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferCondition" ADD CONSTRAINT "OfferCondition_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OfferConditionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
