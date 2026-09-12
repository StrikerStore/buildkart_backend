-- Per-product tiered bulk pricing.
--
-- Replaces one nullable `ProductVariant.bulkPrice` plus one store-wide
-- `bulk.unlockCutoff` setting with a ladder of rungs per variant, measured
-- either by units on a line or by the line's rupee value.
--
-- No backfill, deliberately. The old rule was cart-scoped ("the whole cart is
-- over 10,000, so every bulk item drops") and the new one is line-scoped, so
-- converting an existing bulk price into a rung would silently tighten what
-- mixed carts pay. Ladders are entered fresh; until then everything sells at
-- list, which is the honest starting state rather than a guessed one.

-- Re-runnable, on purpose.
--
-- MySQL has no transactional DDL, so a migration that fails partway leaves
-- every statement before the failure applied. `migrate-deploy.mjs` then marks
-- the migration rolled back — which tells Prisma it never happened, and is a
-- lie the database does not share — and the retry dies on the wreckage of the
-- first attempt. That is exactly how this one wedged a deploy in a restart
-- loop: `CREATE TABLE` succeeded, the foreign key did not, and every retry
-- afterwards failed with "table already exists".
--
-- So every statement below tolerates having already run. The table is dropped
-- first rather than skipped: a half-applied attempt leaves it without its
-- foreign key, and on the deploy that wedged, with the wrong collation too.
-- Nothing can have written to it, because the migration that creates it has
-- never completed anywhere it is still present.
DROP TABLE IF EXISTS `VariantPriceTier`;

-- The ladder itself.
CREATE TABLE `VariantPriceTier` (
  `id`          VARCHAR(191) NOT NULL,
  `variantId`   VARCHAR(191) NOT NULL,
  `basis`       ENUM('QUANTITY', 'AMOUNT') NOT NULL,
  `minQuantity` INTEGER NULL,
  `minAmount`   DECIMAL(10, 2) NULL,
  `unitPrice`   DECIMAL(10, 2) NOT NULL,
  `position`    INTEGER NOT NULL DEFAULT 0,
  `createdAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3) NOT NULL,

  -- Exactly one threshold, matching the basis. A mis-set basis then fails here
  -- rather than reading a rupee figure as a bag count.
  CONSTRAINT `VariantPriceTier_basis_shape` CHECK (
    (`basis` = 'QUANTITY' AND `minQuantity` IS NOT NULL AND `minAmount` IS NULL) OR
    (`basis` = 'AMOUNT'   AND `minAmount`   IS NOT NULL AND `minQuantity` IS NULL)
  ),

  -- MySQL treats NULLs as distinct, so each unique key dedupes its own basis
  -- and is inert for the other.
  UNIQUE INDEX `VariantPriceTier_variantId_minQuantity_key` (`variantId`, `minQuantity`),
  UNIQUE INDEX `VariantPriceTier_variantId_minAmount_key` (`variantId`, `minAmount`),
  INDEX `VariantPriceTier_variantId_position_idx` (`variantId`, `position`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `VariantPriceTier`
  ADD CONSTRAINT `VariantPriceTier_variantId_fkey`
  FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The column steps, each guarded.
--
-- MySQL has no `ADD COLUMN IF NOT EXISTS` (MariaDB does; this is not MariaDB),
-- so existence is checked against information_schema and the ALTER is run
-- through a prepared statement only when it is still needed.

-- How a product's rungs are read.
SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Product'
            AND COLUMN_NAME = 'bulkTierBasis'),
  'DO 0',
  'ALTER TABLE `Product` ADD COLUMN `bulkTierBasis` ENUM(''QUANTITY'', ''AMOUNT'') NOT NULL DEFAULT ''QUANTITY'''));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- The ledger keeps explaining bulk rates now that they are a list.
SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PriceHistory'
            AND COLUMN_NAME = 'tiersJson'),
  'DO 0',
  'ALTER TABLE `PriceHistory` ADD COLUMN `tiersJson` JSON NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- What an order was actually charged, and why. Nullable: orders placed before
-- ladders existed have no rung to record.
SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderItem'
            AND COLUMN_NAME = 'listUnitPrice'),
  'DO 0',
  'ALTER TABLE `OrderItem`
     ADD COLUMN `listUnitPrice`   DECIMAL(10, 2) NULL,
     ADD COLUMN `tierBasis`       ENUM(''QUANTITY'', ''AMOUNT'') NULL,
     ADD COLUMN `tierMinQuantity` INTEGER NULL,
     ADD COLUMN `tierMinAmount`   DECIMAL(10, 2) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- The old model. `PriceHistory.bulkPrice` stays so historical rows still read
-- correctly; only the live column and the store-wide setting go.
--
-- Guarded like the adds above, and for the same reason: a rerun after a partial
-- apply would otherwise fail on a column that is already gone.
SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductVariant'
            AND COLUMN_NAME = 'bulkPrice'),
  'ALTER TABLE `ProductVariant` DROP COLUMN `bulkPrice`',
  'DO 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Already idempotent: deleting a row that is gone removes nothing.
DELETE FROM `Setting` WHERE `key` = 'bulk.unlockCutoff';
