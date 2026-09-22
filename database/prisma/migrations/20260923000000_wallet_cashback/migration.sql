-- Store-credit wallet and cashback.
--
-- A customer's wallet is a set of lots (`WalletLot`), one per credit — signup
-- bonus, cashback, admin top-up — each with its own expiry. `WalletEntry` is
-- the statement the customer reads; `WalletLotUse` records which lots a spend
-- drew from, so a cancelled order's spend is returned to the same lots.
--
-- Orders gain what they spent from the wallet (`walletApplied`, mirrored as a
-- STORE_CREDIT payment in the ledger) and the cashback they earn, which waits
-- as PENDING until `cashbackReleaseAt` — set on delivery — and is then credited
-- by the `/cron/wallet` job.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery:
-- MySQL has no transactional DDL, so every statement tolerates having run.

-- Child first.
DROP TABLE IF EXISTS `WalletLotUse`;
DROP TABLE IF EXISTS `WalletEntry`;
DROP TABLE IF EXISTS `WalletLot`;

-- Customer ------------------------------------------------------------------

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'walletBalance'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `walletBalance` DECIMAL(10, 2) NOT NULL DEFAULT 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'signupBonusAt'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `signupBonusAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Everyone who already has an account is settled as "not owed": the signup
-- bonus is for accounts created from here on. Stamped with their own creation
-- time so the column still says something true about them.
UPDATE `Customer` SET `signupBonusAt` = `createdAt` WHERE `signupBonusAt` IS NULL;

-- Order ---------------------------------------------------------------------

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'walletApplied'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `walletApplied` DECIMAL(10, 2) NOT NULL DEFAULT 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'cashbackAmount'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `cashbackAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'cashbackStatus'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `cashbackStatus` ENUM(''NONE'', ''PENDING'', ''CREDITED'', ''VOIDED'') NOT NULL DEFAULT ''NONE'''));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME = 'cashbackReleaseAt'),
  'DO 0',
  'ALTER TABLE `Order` ADD COLUMN `cashbackReleaseAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND INDEX_NAME = 'Order_cashbackStatus_cashbackReleaseAt_idx'),
  'DO 0',
  'CREATE INDEX `Order_cashbackStatus_cashbackReleaseAt_idx` ON `Order`(`cashbackStatus`, `cashbackReleaseAt`)'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- STORE_CREDIT appended to the gateway enum — an instant change, since it is
-- at the end. Both statements are idempotent as written.
ALTER TABLE `Order` MODIFY `paymentGateway` ENUM('RAZORPAY', 'SNAPMINT', 'CASH', 'UPI_DIRECT', 'BANK_TRANSFER', 'PAYU', 'STORE_CREDIT') NULL;
ALTER TABLE `PaymentTransaction` MODIFY `gateway` ENUM('RAZORPAY', 'SNAPMINT', 'CASH', 'UPI_DIRECT', 'BANK_TRANSFER', 'PAYU', 'STORE_CREDIT') NOT NULL;

-- Wallet --------------------------------------------------------------------

CREATE TABLE `WalletLot` (
  `id`         VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `source`     ENUM('SIGNUP_BONUS', 'CASHBACK', 'ADMIN_CREDIT') NOT NULL,
  `amount`     DECIMAL(10, 2) NOT NULL,
  `remaining`  DECIMAL(10, 2) NOT NULL,
  `expiresAt`  DATETIME(3) NULL,
  `orderId`    VARCHAR(191) NULL,
  `createdAt`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  -- Spending walks one customer's lots in expiry order.
  INDEX `WalletLot_customerId_expiresAt_idx` (`customerId`, `expiresAt`),
  -- The expiry job looks for lots past their date with something left.
  INDEX `WalletLot_expiresAt_remaining_idx` (`expiresAt`, `remaining`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WalletEntry` (
  `id`           VARCHAR(191) NOT NULL,
  `customerId`   VARCHAR(191) NOT NULL,
  `type`         ENUM('SIGNUP_BONUS', 'CASHBACK', 'REDEMPTION', 'REDEMPTION_REVERSAL', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'EXPIRY') NOT NULL,
  `amount`       DECIMAL(10, 2) NOT NULL,
  `balanceAfter` DECIMAL(10, 2) NOT NULL,
  `orderId`      VARCHAR(191) NULL,
  `lotId`        VARCHAR(191) NULL,
  `note`         VARCHAR(255) NULL,
  `adminUserId`  VARCHAR(191) NULL,
  `createdAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `WalletEntry_customerId_createdAt_idx` (`customerId`, `createdAt`),
  INDEX `WalletEntry_orderId_idx` (`orderId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WalletLotUse` (
  `id`      VARCHAR(191) NOT NULL,
  `entryId` VARCHAR(191) NOT NULL,
  `lotId`   VARCHAR(191) NOT NULL,
  `amount`  DECIMAL(10, 2) NOT NULL,

  INDEX `WalletLotUse_entryId_idx` (`entryId`),
  INDEX `WalletLotUse_lotId_idx` (`lotId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `WalletLot`
  ADD CONSTRAINT `WalletLot_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WalletLot`
  ADD CONSTRAINT `WalletLot_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WalletEntry`
  ADD CONSTRAINT `WalletEntry_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WalletEntry`
  ADD CONSTRAINT `WalletEntry_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WalletEntry`
  ADD CONSTRAINT `WalletEntry_lotId_fkey`
  FOREIGN KEY (`lotId`) REFERENCES `WalletLot`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WalletEntry`
  ADD CONSTRAINT `WalletEntry_adminUserId_fkey`
  FOREIGN KEY (`adminUserId`) REFERENCES `AdminUser`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `WalletLotUse`
  ADD CONSTRAINT `WalletLotUse_entryId_fkey`
  FOREIGN KEY (`entryId`) REFERENCES `WalletEntry`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `WalletLotUse`
  ADD CONSTRAINT `WalletLotUse_lotId_fkey`
  FOREIGN KEY (`lotId`) REFERENCES `WalletLot`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
