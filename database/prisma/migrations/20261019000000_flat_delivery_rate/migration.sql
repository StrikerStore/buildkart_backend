-- The flat delivery rate moves off the pincode and onto the Delivery charges
-- screen: one charge and one free-delivery threshold for the whole shop, kept
-- on the `delivery.distancePricing` setting beside the distance rules it
-- stands in for. A pincode now only says whether the shop delivers there.
--
-- Carried across rather than defaulted, so a deploy does not quietly make
-- every delivery free. The per-area figures may disagree; the pair most active
-- areas were using is taken, ties going to the lower charge and then the lower
-- threshold, and the owner confirms it on the screen. Paused areas do not
-- count. With no active area at all the rate starts at zero, as the old column
-- default did.
--
-- The `ServiceablePincode` columns are left in place and no longer read, so the
-- per-area figures can still be looked up until a later migration drops them.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery:
-- a setting that already carries a flat rate is left alone.

-- Two lookups with one ordering, so both land on the same (charge, threshold)
-- pair. A subquery with no rows yields NULL rather than an error.
SET @flatCharge := (
  SELECT CAST(`deliveryCharge` AS CHAR)
    FROM `ServiceablePincode`
   WHERE `isActive` = true
   GROUP BY `deliveryCharge`, `freeDeliveryAbove`
   ORDER BY COUNT(*) DESC, `deliveryCharge` ASC,
            `freeDeliveryAbove` IS NULL, `freeDeliveryAbove` ASC
   LIMIT 1);

SET @flatFreeAbove := (
  SELECT CAST(`freeDeliveryAbove` AS CHAR)
    FROM `ServiceablePincode`
   WHERE `isActive` = true
   GROUP BY `deliveryCharge`, `freeDeliveryAbove`
   ORDER BY COUNT(*) DESC, `deliveryCharge` ASC,
            `freeDeliveryAbove` IS NULL, `freeDeliveryAbove` ASC
   LIMIT 1);

-- A missing row is created holding only the flat rate; every other field of
-- the setting defaults when it is read, exactly as an absent row does today.
INSERT INTO `Setting` (`key`, `value`, `updatedAt`)
VALUES ('delivery.distancePricing',
        JSON_OBJECT('flatCharge',    COALESCE(@flatCharge, '0.00'),
                    'flatFreeAbove', @flatFreeAbove),
        NOW(3))
ON DUPLICATE KEY UPDATE
  `value` = IF(JSON_CONTAINS_PATH(`value`, 'one', '$.flatCharge'),
               `value`,
               JSON_SET(`value`,
                        '$.flatCharge',    COALESCE(@flatCharge, '0.00'),
                        '$.flatFreeAbove', @flatFreeAbove)),
  `updatedAt` = NOW(3);
