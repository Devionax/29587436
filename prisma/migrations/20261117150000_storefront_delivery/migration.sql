-- Additive: a new condition field for total cart quantity.
-- No table is rewritten, no column is dropped, no row is modified.
ALTER TYPE "ConditionField" ADD VALUE IF NOT EXISTS 'CART_TOTAL_QUANTITY';
