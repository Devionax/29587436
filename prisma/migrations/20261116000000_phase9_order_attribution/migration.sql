-- One order can credit more than one upsell offer, and the stored amount is the
-- attributed line subtotal rather than the whole order subtotal.
ALTER TABLE "OrderAttribution" RENAME COLUMN "orderSubtotal" TO "lineSubtotal";

DROP INDEX "OrderAttribution_orderGid_key";

CREATE INDEX "OrderAttribution_orderGid_idx" ON "OrderAttribution"("orderGid");

CREATE UNIQUE INDEX "OrderAttribution_orderGid_offerVariantGid_key" ON "OrderAttribution"("orderGid", "offerVariantGid");
