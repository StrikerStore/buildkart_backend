-- Erasure: an erased customer, an anonymised order, and a deletion's schedule.
--
-- `Customer.erasedAt` marks an account whose person has been removed from it
-- (DPDP Act §12); `Order.piiErasedAt` an order whose personal details were
-- cleared once tax law stopped requiring them; `PrivacyRequest.scheduledFor`
-- when a confirmed "delete my account" runs after its cooling-off week.
-- Nothing is backfilled: nothing has been erased yet.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'erasedAt'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `erasedAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'piiErasedAt'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `piiErasedAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PrivacyRequest'
            AND COLUMN_NAME = 'scheduledFor'),
  'DO 0',
  'ALTER TABLE `PrivacyRequest` ADD COLUMN `scheduledFor` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
