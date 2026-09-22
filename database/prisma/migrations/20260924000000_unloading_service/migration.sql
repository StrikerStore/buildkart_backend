-- The unloading service: an optional flat fee a customer can add in the cart.
--
-- Stored on the order, frozen at the price of the day, beside the delivery
-- charge it resembles — both are part of `grandTotal` and neither is goods.
-- The price and wording live in the `delivery.unloading` setting, so this is
-- the only schema change the feature needs.
--
-- Guarded for the reason given in 20260920000000_warehouses_distance_delivery:
-- MySQL has no `ADD COLUMN IF NOT EXISTS`, and a migration must survive
-- having partly run.
SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'unloadingCharge'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `unloadingCharge` DECIMAL(10, 2) NOT NULL DEFAULT 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
