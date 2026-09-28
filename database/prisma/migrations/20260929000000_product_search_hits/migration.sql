-- Search hits, for the homepage's TRENDING band.
--
-- One row per shopper per product per day, written when a product is opened
-- from the search dropdown or the search results page. The composite primary
-- key is the de-duplication: a repeat open, or a replayed call, is an INSERT
-- IGNORE that changes nothing. `visitor` is a hash of IP + day, not the IP.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery:
-- MySQL has no transactional DDL, so every statement tolerates having run.

CREATE TABLE IF NOT EXISTS `ProductSearchHit` (
  `productId` VARCHAR(191) NOT NULL,
  `day`       DATE NOT NULL,
  `visitor`   CHAR(64) NOT NULL,

  -- The band sums a window of days, then groups by product.
  INDEX `ProductSearchHit_day_productId_idx` (`day`, `productId`),
  PRIMARY KEY (`productId`, `day`, `visitor`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductSearchHit'
            AND CONSTRAINT_NAME = 'ProductSearchHit_productId_fkey'),
  'DO 0',
  'ALTER TABLE `ProductSearchHit` ADD CONSTRAINT `ProductSearchHit_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
