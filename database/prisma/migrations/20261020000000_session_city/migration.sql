-- Cities on storefront sessions, for the city reports on the Acquisition and
-- Meta ads pages.
--
-- A session's city is the delivery area the shopper chose on the storefront.
-- No backfill: sessions before this have none, and report as "Not chosen".
--
-- `AnalyticsDaily` gains the city as a fourth key column so the summary keeps
-- cities past the 90 days raw sessions are held. Existing rows take the empty
-- city, which is what they are — summaries made before cities were recorded.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'StorefrontSession'
            AND COLUMN_NAME = 'city'),
  'DO 0',
  'ALTER TABLE `StorefrontSession` ADD COLUMN `city` VARCHAR(100) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AnalyticsDaily'
            AND COLUMN_NAME = 'city'),
  'DO 0',
  'ALTER TABLE `AnalyticsDaily` ADD COLUMN `city` VARCHAR(100) NOT NULL DEFAULT '''''));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- One statement, so the table is never left without a primary key.
SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AnalyticsDaily'
            AND CONSTRAINT_NAME = 'PRIMARY' AND COLUMN_NAME = 'city'),
  'DO 0',
  'ALTER TABLE `AnalyticsDaily` DROP PRIMARY KEY, ADD PRIMARY KEY (`day`, `channel`, `device`, `city`)'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
