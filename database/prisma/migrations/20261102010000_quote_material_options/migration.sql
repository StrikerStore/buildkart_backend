-- Which products the Get a quote calculator can offer for each material, and
-- what one sale unit of each covers.
--
-- The catalogue has no pack size or coverage to read: "50 kg" only exists inside
-- a product's name. So the admin says it here: one bag of this cement covers 50
-- kg, one brass of this sand covers 100 cft. A material with no row is simply
-- shown with its quantity and "ask for a rate".
--
-- A variant belongs to one material, which is why `variantId` is unique. The
-- rows go with the variant.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

CREATE TABLE IF NOT EXISTS `QuoteMaterialOption` (
  `id`                   VARCHAR(191)  NOT NULL,
  `material`             VARCHAR(32)   NOT NULL,
  `variantId`            VARCHAR(191)  NOT NULL,
  `baseUnitsPerSaleUnit` DECIMAL(10, 3) NOT NULL,
  `position`             INTEGER       NOT NULL DEFAULT 0,
  `createdAt`            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`            DATETIME(3)   NOT NULL,

  UNIQUE INDEX `QuoteMaterialOption_variantId_key` (`variantId`),
  INDEX `QuoteMaterialOption_material_position_idx` (`material`, `position`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'QuoteMaterialOption'
            AND CONSTRAINT_NAME = 'QuoteMaterialOption_variantId_fkey'),
  'DO 0',
  'ALTER TABLE `QuoteMaterialOption` ADD CONSTRAINT `QuoteMaterialOption_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
