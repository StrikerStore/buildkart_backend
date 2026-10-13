-- Two times on an order.
--
-- `expectedDeliveryAt`: entered on "Send out for delivery" and quoted to the
-- customer in the out-for-delivery WhatsApp message.
-- `autoConfirmAt`: set on storefront orders a minute after they are placed; a
-- sweep confirms any order still Placed once it passes. Indexed with `status`
-- because that sweep is the only query that reads it.
--
-- Both nullable: every existing order simply has neither.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'expectedDeliveryAt'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `expectedDeliveryAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'autoConfirmAt'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `autoConfirmAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND INDEX_NAME = 'Order_status_autoConfirmAt_idx'),
  'DO 0',
  'CREATE INDEX `Order_status_autoConfirmAt_idx` ON `Order`(`status`, `autoConfirmAt`)'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
