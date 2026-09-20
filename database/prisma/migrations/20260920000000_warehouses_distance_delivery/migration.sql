-- Warehouses, and the delivery charge worked out from the distance to one.
--
-- Until now the charge was a flat per-area number on `ServiceablePincode`:
-- everyone in a pincode paid the same whether they were two kilometres from the
-- godown or twenty-five. These two tables supply what was missing — a stocking
-- point with coordinates, and a routing map saying which point can serve which
-- variant.
--
-- `WarehouseStock` is deliberately **not** inventory. `ProductVariant.stockQty`
-- remains the shelf and the only thing an order decrements; a row here answers
-- "could this be sent from there", which is what fixes the distance. Keeping
-- the two apart is what lets this ship without touching the order write path.
--
-- No backfill. With no warehouses entered the new engine has nothing to route
-- with and falls back to the per-pincode charge, which is also what the
-- `delivery.distancePricing` setting does while it is off — the state this
-- migration lands in is the state the shop is already running.

-- Re-runnable, on purpose.
--
-- MySQL has no transactional DDL, so a migration that fails partway leaves
-- every statement before the failure applied, and `migrate-deploy.mjs` then
-- marks it rolled back — a lie the database does not share. Every statement
-- below therefore tolerates having already run. The tables are dropped first
-- rather than skipped: a half-applied attempt leaves them without their foreign
-- keys, and nothing can have written to them, because the migration that
-- creates them has never completed anywhere they are still present.
--
-- Child first: `WarehouseStock` holds the foreign key into `Warehouse`.
DROP TABLE IF EXISTS `WarehouseStock`;
DROP TABLE IF EXISTS `Warehouse`;

-- The stocking point. `latitude`/`longitude` are the load-bearing columns; the
-- postal address is for the human reading the admin.
CREATE TABLE `Warehouse` (
  `id`        VARCHAR(191) NOT NULL,
  `name`      VARCHAR(191) NOT NULL,
  `code`      VARCHAR(32)  NOT NULL,
  `line1`     VARCHAR(255) NOT NULL,
  `line2`     VARCHAR(255) NULL,
  `city`      VARCHAR(100) NOT NULL,
  `state`     VARCHAR(100) NOT NULL,
  `pincode`   VARCHAR(10)  NOT NULL,

  -- DECIMAL, not DOUBLE — the same choice `Address` makes, for the same
  -- reason: this is navigated to, and a float drifts.
  `latitude`  DECIMAL(10, 7) NOT NULL,
  `longitude` DECIMAL(10, 7) NOT NULL,

  -- Breaks ties between two equidistant warehouses, so a cart priced twice
  -- picks the same one both times.
  `position`  INTEGER NOT NULL DEFAULT 0,
  `isActive`  BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `Warehouse_code_key` (`code`),
  INDEX `Warehouse_isActive_position_idx` (`isActive`, `position`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The routing map. Not inventory — see the header.
CREATE TABLE `WarehouseStock` (
  `id`          VARCHAR(191) NOT NULL,
  `warehouseId` VARCHAR(191) NOT NULL,
  `variantId`   VARCHAR(191) NOT NULL,
  `quantity`    INTEGER NOT NULL DEFAULT 0,
  `updatedAt`   DATETIME(3) NOT NULL,

  UNIQUE INDEX `WarehouseStock_warehouseId_variantId_key` (`warehouseId`, `variantId`),
  -- The routing query is "which warehouses hold this variant", so the variant
  -- leads the index. `quantity` rides along so the `> 0` filter is covered.
  INDEX `WarehouseStock_variantId_quantity_idx` (`variantId`, `quantity`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WarehouseStock`
  ADD CONSTRAINT `WarehouseStock_warehouseId_fkey`
  FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WarehouseStock`
  ADD CONSTRAINT `WarehouseStock_variantId_fkey`
  FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- What an order was actually charged, and from where.
--
-- Frozen for the same reason as `taxBreakdown`: ops needs to know which godown
-- sent what, and recomputing it later from live warehouse rows would answer for
-- today's stock rather than the day the order was placed. Nullable, because
-- orders charged by the per-pincode rule have no legs to record — which is
-- every order that exists today.
--
-- Guarded: MySQL has no `ADD COLUMN IF NOT EXISTS` (MariaDB does; this is not
-- MariaDB), so existence is checked against information_schema and the ALTER
-- runs through a prepared statement only when it is still needed.
SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'deliveryLegs'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `deliveryLegs` JSON NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
