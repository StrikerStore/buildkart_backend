-- The rates screen can now change the MRP alongside the selling price, so the
-- ledger records it. Nullable: every row written before this change has no MRP
-- to backfill, and inventing one would misreport history.
ALTER TABLE `PriceHistory` ADD COLUMN `compareAtPrice` DECIMAL(10, 2) NULL;
