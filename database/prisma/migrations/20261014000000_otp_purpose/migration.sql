-- What a one-time code is for: signing in, or confirming a cash-on-delivery
-- order. Every existing code was a sign-in code, which is the default.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'CustomerOtp'
            AND COLUMN_NAME = 'purpose'),
  'DO 0',
  'ALTER TABLE `CustomerOtp` ADD COLUMN `purpose` VARCHAR(16) NOT NULL DEFAULT ''LOGIN'''));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
