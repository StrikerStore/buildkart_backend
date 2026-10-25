-- Distance pricing figures move from the product to the variant.
--
-- A distance-priced product's per-unit addition differs by size — a 50 kg bag
-- costs more to carry than a 25 kg one — so `ProductVariant` gains its own
-- `distanceBaseAddition`, `distanceBlockKm` and `distancePerBlockAddition`.
-- `Product.pricingKind` stays: a product is distance-priced or not as a whole.
--
-- Each product's current figures are copied onto every one of its variants, so
-- nothing anyone pays changes at deploy. Only variants still at the column
-- defaults are touched, so re-running this cannot overwrite figures someone has
-- since set on a variant.
--
-- The `Product.distance*` columns are left in place, unread, so the previous
-- backend keeps working while a deploy rolls over; a later migration drops them.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductVariant'
            AND COLUMN_NAME = 'distanceBaseAddition'),
  'DO 0',
  'ALTER TABLE `ProductVariant` ADD COLUMN `distanceBaseAddition` DECIMAL(10, 2) NOT NULL DEFAULT 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductVariant'
            AND COLUMN_NAME = 'distanceBlockKm'),
  'DO 0',
  'ALTER TABLE `ProductVariant` ADD COLUMN `distanceBlockKm` DECIMAL(5, 2) NOT NULL DEFAULT 5'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductVariant'
            AND COLUMN_NAME = 'distancePerBlockAddition'),
  'DO 0',
  'ALTER TABLE `ProductVariant` ADD COLUMN `distancePerBlockAddition` DECIMAL(10, 2) NOT NULL DEFAULT 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Every product's figures onto its variants, whatever its kind: they are kept
-- on a flat-priced product too, so switching it to distance restores them.
UPDATE `ProductVariant` v
  JOIN `Product` p ON p.`id` = v.`productId`
   SET v.`distanceBaseAddition` = p.`distanceBaseAddition`,
       v.`distanceBlockKm` = p.`distanceBlockKm`,
       v.`distancePerBlockAddition` = p.`distancePerBlockAddition`
 WHERE v.`distanceBaseAddition` = 0
   AND v.`distancePerBlockAddition` = 0
   AND v.`distanceBlockKm` = 5;
