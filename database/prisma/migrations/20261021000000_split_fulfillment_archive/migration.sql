-- Orders sent in several loads, closed short, and archived.
--
-- `OrderShipment` / `OrderShipmentItem`: each load of an order and what went
-- in it. `PaymentTransaction.shipmentId` ties a load's cash to it.
-- `PARTIALLY_DELIVERED` is appended to the order status enum on all three
-- columns that use it — appended, never inserted: MySQL stores an ENUM as its
-- ordinal. `Order.closedShortAt/closedShortReason` and
-- `OrderItem.orderedQuantity` record an order ended with what had arrived.
-- `Order.archivedAt` puts a finished order away from the main list.
--
-- Orders already out for delivery get their Delivery 1 here, covering every
-- item, so a second load can never be created for goods already on the road.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

-- --- order status ---------------------------------------------------------

ALTER TABLE `Order`
  MODIFY `status` ENUM('PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'PARTIALLY_DELIVERED') NOT NULL DEFAULT 'PLACED';

ALTER TABLE `OrderStatusEvent`
  MODIFY `fromStatus` ENUM('PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'PARTIALLY_DELIVERED') NULL;

ALTER TABLE `OrderStatusEvent`
  MODIFY `toStatus` ENUM('PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'PARTIALLY_DELIVERED') NOT NULL;

-- --- new columns ------------------------------------------------------------

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'closedShortAt'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `closedShortAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'closedShortReason'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `closedShortReason` VARCHAR(255) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'archivedAt'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `archivedAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND INDEX_NAME = 'Order_archivedAt_placedAt_idx'),
  'DO 0',
  'CREATE INDEX `Order_archivedAt_placedAt_idx` ON `Order`(`archivedAt`, `placedAt`)'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderItem'
            AND COLUMN_NAME = 'orderedQuantity'),
  'DO 0',
  'ALTER TABLE `OrderItem` ADD COLUMN `orderedQuantity` INTEGER NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- --- deliveries -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `OrderShipment` (
  `id`                 VARCHAR(191) NOT NULL,
  `orderId`            VARCHAR(191) NOT NULL,
  `number`             INTEGER NOT NULL,
  `status`             ENUM('OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED') NOT NULL DEFAULT 'OUT_FOR_DELIVERY',
  `expectedDeliveryAt` DATETIME(3) NULL,
  `deliveredAt`        DATETIME(3) NULL,
  `cancelledAt`        DATETIME(3) NULL,
  `note`               VARCHAR(255) NULL,
  `createdByAdminId`   VARCHAR(191) NULL,
  `createdAt`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`          DATETIME(3) NOT NULL,

  UNIQUE INDEX `OrderShipment_orderId_number_key` (`orderId`, `number`),
  INDEX `OrderShipment_orderId_status_idx` (`orderId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `OrderShipmentItem` (
  `id`               VARCHAR(191) NOT NULL,
  `shipmentId`       VARCHAR(191) NOT NULL,
  `orderItemId`      VARCHAR(191) NOT NULL,
  `quantity`         INTEGER NOT NULL,
  `receivedQuantity` INTEGER NULL,

  UNIQUE INDEX `OrderShipmentItem_shipmentId_orderItemId_key` (`shipmentId`, `orderItemId`),
  INDEX `OrderShipmentItem_orderItemId_idx` (`orderItemId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderShipment'
            AND CONSTRAINT_NAME = 'OrderShipment_orderId_fkey'),
  'DO 0',
  'ALTER TABLE `OrderShipment` ADD CONSTRAINT `OrderShipment_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderShipmentItem'
            AND CONSTRAINT_NAME = 'OrderShipmentItem_shipmentId_fkey'),
  'DO 0',
  'ALTER TABLE `OrderShipmentItem` ADD CONSTRAINT `OrderShipmentItem_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `OrderShipment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderShipmentItem'
            AND CONSTRAINT_NAME = 'OrderShipmentItem_orderItemId_fkey'),
  'DO 0',
  'ALTER TABLE `OrderShipmentItem` ADD CONSTRAINT `OrderShipmentItem_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `OrderItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- --- a delivery's cash ---------------------------------------------------

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PaymentTransaction'
            AND COLUMN_NAME = 'shipmentId'),
  'DO 0',
  'ALTER TABLE `PaymentTransaction` ADD COLUMN `shipmentId` VARCHAR(191) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PaymentTransaction'
            AND CONSTRAINT_NAME = 'PaymentTransaction_shipmentId_fkey'),
  'DO 0',
  'ALTER TABLE `PaymentTransaction` ADD CONSTRAINT `PaymentTransaction_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `OrderShipment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- --- Delivery 1 for orders already on the road --------------------------
--
-- Deterministic ids (`<order id>-1`, `<item id>-1`) so a re-run inserts
-- nothing twice.

INSERT INTO `OrderShipment`
  (`id`, `orderId`, `number`, `status`, `expectedDeliveryAt`, `createdAt`, `updatedAt`)
SELECT CONCAT(o.`id`, '-1'), o.`id`, 1, 'OUT_FOR_DELIVERY', o.`expectedDeliveryAt`,
       CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
  FROM `Order` o
 WHERE o.`status` = 'OUT_FOR_DELIVERY'
   AND NOT EXISTS (SELECT 1 FROM `OrderShipment` s WHERE s.`orderId` = o.`id`);

INSERT INTO `OrderShipmentItem` (`id`, `shipmentId`, `orderItemId`, `quantity`)
SELECT CONCAT(oi.`id`, '-1'), s.`id`, oi.`id`, oi.`quantity`
  FROM `OrderItem` oi
  JOIN `OrderShipment` s ON s.`id` = CONCAT(oi.`orderId`, '-1')
 WHERE NOT EXISTS (SELECT 1 FROM `OrderShipmentItem` x WHERE x.`id` = CONCAT(oi.`id`, '-1'));
