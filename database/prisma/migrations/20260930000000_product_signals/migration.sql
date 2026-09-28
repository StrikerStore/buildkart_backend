-- Trending ranks more than search: `ProductSearchHit` becomes `ProductSignal`,
-- one row per shopper per product per day per *kind* — VIEW, SEARCH or CART.
-- Orders are counted from the order tables and are not copied here.
--
-- A new table and a copy rather than a rename in place: the primary key gains
-- a column, and on MySQL that means dropping the key the foreign key leans on.
-- Building the new table beside the old one avoids that dance entirely. Every
-- existing row was a search open, so each is carried over as SEARCH.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery:
-- MySQL has no transactional DDL, so every statement tolerates having run.

CREATE TABLE IF NOT EXISTS `ProductSignal` (
  `productId` VARCHAR(191) NOT NULL,
  `day`       DATE NOT NULL,
  `kind`      VARCHAR(16) NOT NULL,
  `visitor`   CHAR(64) NOT NULL,

  -- The band reads a window of days, then groups by product and kind.
  INDEX `ProductSignal_day_productId_idx` (`day`, `productId`),
  PRIMARY KEY (`productId`, `day`, `kind`, `visitor`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductSignal'
            AND CONSTRAINT_NAME = 'ProductSignal_productId_fkey'),
  'DO 0',
  'ALTER TABLE `ProductSignal` ADD CONSTRAINT `ProductSignal_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Carry the search opens across, then retire the old table. Both guarded, so a
-- second run after the drop is a no-op rather than an error.
SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductSearchHit'),
  'INSERT IGNORE INTO `ProductSignal` (`productId`, `day`, `kind`, `visitor`) SELECT `productId`, `day`, ''SEARCH'', `visitor` FROM `ProductSearchHit`',
  'DO 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

DROP TABLE IF EXISTS `ProductSearchHit`;
