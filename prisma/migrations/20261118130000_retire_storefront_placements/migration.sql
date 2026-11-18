-- Retire the storefront placements for the post-purchase-only release.
--
-- Only the two delivery switches change on each row. Offers, products,
-- conditions, schedules, analytics and history are untouched, and both columns
-- stay in the schema so the data model can serve a storefront surface again
-- later without a destructive migration.
UPDATE "RecommendationRule"
SET "showOnProductPage" = false,
    "showOnCartPage" = false;

UPDATE "ShopSettings"
SET "productPageEnabled" = false,
    "cartPageEnabled" = false;
