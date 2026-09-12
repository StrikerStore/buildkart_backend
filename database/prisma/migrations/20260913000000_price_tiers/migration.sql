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
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

ALTER TABLE `VariantPriceTier`
  ADD CONSTRAINT `VariantPriceTier_variantId_fkey`
  FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- How a product's rungs are read.
ALTER TABLE `Product`
  ADD COLUMN `bulkTierBasis` ENUM('QUANTITY', 'AMOUNT') NOT NULL DEFAULT 'QUANTITY';

-- The ledger keeps explaining bulk rates now that they are a list.
ALTER TABLE `PriceHistory` ADD COLUMN `tiersJson` JSON NULL;

-- What an order was actually charged, and why. Nullable: orders placed before
-- ladders existed have no rung to record.
ALTER TABLE `OrderItem`
  ADD COLUMN `listUnitPrice`   DECIMAL(10, 2) NULL,
  ADD COLUMN `tierBasis`       ENUM('QUANTITY', 'AMOUNT') NULL,
  ADD COLUMN `tierMinQuantity` INTEGER NULL,
  ADD COLUMN `tierMinAmount`   DECIMAL(10, 2) NULL;

-- The old model. `PriceHistory.bulkPrice` stays so historical rows still read
-- correctly; only the live column and the store-wide setting go.
ALTER TABLE `ProductVariant` DROP COLUMN `bulkPrice`;
DELETE FROM `Setting` WHERE `key` = 'bulk.unlockCutoff';
