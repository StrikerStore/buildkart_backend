-- Two kinds of product, and a new delivery charge for one of them.
--
-- `Product.pricingKind` FLAT (every existing product, by the column default)
-- is the same price everywhere, with the order paying a delivery charge.
-- DISTANCE adds `distanceBaseAddition` plus `distancePerBlockAddition` for
-- every `distanceBlockKm` started to each unit, and delivers free.
--
-- `OrderItem.distance*` freeze what a distance-priced line added and from how
-- far; `Order.deliveryBreakdown` freezes how the delivery charge was reached.
-- `Order.deliveryLegs` stays for the orders that have it and is no longer
-- written.
--
-- The delivery charge moves to a new setting key, `delivery.charges`: a base
-- by cart-total slab plus a charge per distance range, free above a threshold.
-- Carried across from today's flat rate rather than defaulted, so a deploy
-- does not quietly make every delivery free — or change what anyone pays: one
-- slab charging the old flat charge, one range adding nothing, and the old
-- free-above threshold. A shop that was charging by distance (`enabled`) has
-- no exact equivalent and sets its slabs and ranges on the Delivery charges
-- screen. The old `delivery.distancePricing` row is left in place so a code
-- rollback still reads it; a later migration deletes it.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Product'
            AND COLUMN_NAME = 'pricingKind'),
  'DO 0',
  'ALTER TABLE `Product` ADD COLUMN `pricingKind` ENUM(''FLAT'', ''DISTANCE'') NOT NULL DEFAULT ''FLAT'''));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Product'
            AND COLUMN_NAME = 'distanceBaseAddition'),
  'DO 0',
  'ALTER TABLE `Product` ADD COLUMN `distanceBaseAddition` DECIMAL(10, 2) NOT NULL DEFAULT 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Product'
            AND COLUMN_NAME = 'distanceBlockKm'),
  'DO 0',
  'ALTER TABLE `Product` ADD COLUMN `distanceBlockKm` DECIMAL(5, 2) NOT NULL DEFAULT 5'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Product'
            AND COLUMN_NAME = 'distancePerBlockAddition'),
  'DO 0',
  'ALTER TABLE `Product` ADD COLUMN `distancePerBlockAddition` DECIMAL(10, 2) NOT NULL DEFAULT 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderItem'
            AND COLUMN_NAME = 'distanceAddition'),
  'DO 0',
  'ALTER TABLE `OrderItem` ADD COLUMN `distanceAddition` DECIMAL(10, 2) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderItem'
            AND COLUMN_NAME = 'distanceKm'),
  'DO 0',
  'ALTER TABLE `OrderItem` ADD COLUMN `distanceKm` DECIMAL(7, 1) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderItem'
            AND COLUMN_NAME = 'distanceWarehouseCode'),
  'DO 0',
  'ALTER TABLE `OrderItem` ADD COLUMN `distanceWarehouseCode` VARCHAR(32) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'deliveryBreakdown'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `deliveryBreakdown` JSON NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Today's flat rate, carried into the new key. No old row means the shop never
-- set a charge, and the new key's defaults charge nothing — as before. A row
-- that already exists under the new key is left alone.
INSERT INTO `Setting` (`key`, `value`, `updatedAt`)
SELECT 'delivery.charges',
       JSON_OBJECT(
         'roadFactor',
         COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(`value`, '$.roadFactor')) AS DECIMAL(4, 2)), 1.3),
         'slabs',
         JSON_ARRAY(JSON_OBJECT(
           'from', '0.00',
           'base', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`value`, '$.flatCharge')), '0.00'))),
         'ranges',
         JSON_ARRAY(JSON_OBJECT('upToKm', 5, 'addition', '0.00')),
         'freeAbove',
         JSON_EXTRACT(`value`, '$.flatFreeAbove')),
       NOW(3)
  FROM `Setting`
 WHERE `key` = 'delivery.distancePricing'
ON DUPLICATE KEY UPDATE `key` = `key`;
