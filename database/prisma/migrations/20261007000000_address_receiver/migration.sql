-- Who takes the delivery at an address, when it is not the account holder.
-- Both nullable: every existing address keeps falling back to the customer.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Address'
            AND COLUMN_NAME = 'receiverName'),
  'DO 0',
  'ALTER TABLE `Address` ADD COLUMN `receiverName` VARCHAR(191) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Address'
            AND COLUMN_NAME = 'receiverPhone'),
  'DO 0',
  'ALTER TABLE `Address` ADD COLUMN `receiverPhone` VARCHAR(20) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
