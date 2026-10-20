-- Requests from people about their own data, and the customer's nominee.
--
-- `PrivacyRequest` is the queue the DPDP Act's rights run through: a request
-- to see, correct or erase data, or a complaint, with the 90-day deadline the
-- Rules set. No foreign key to `Customer` — a request can come from someone
-- with no account, and the record of an erasure must outlive it.
--
-- The nominee columns hold who may use a customer's rights if they cannot
-- (DPDP Act §14). Nothing is backfilled: nobody has named one yet.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'nomineeName'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `nomineeName` VARCHAR(191) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'nomineeRelation'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `nomineeRelation` VARCHAR(64) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'nomineePhone'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `nomineePhone` VARCHAR(20) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'nomineeUpdatedAt'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `nomineeUpdatedAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS `PrivacyRequest` (
  `id`          VARCHAR(191) NOT NULL,
  `customerId`  VARCHAR(191) NULL,
  `phone`       VARCHAR(20)  NOT NULL,
  `type`        VARCHAR(32)  NOT NULL,
  `status`      VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
  `details`     TEXT         NOT NULL,
  `source`      VARCHAR(16)  NOT NULL,
  `channel`     VARCHAR(100) NULL,
  `resolution`  TEXT         NULL,
  `dueAt`       DATETIME(3)  NOT NULL,
  `resolvedAt`  DATETIME(3)  NULL,
  `handledById` VARCHAR(191) NULL,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3)  NOT NULL,

  INDEX `PrivacyRequest_status_dueAt_idx` (`status`, `dueAt`),
  INDEX `PrivacyRequest_customerId_createdAt_idx` (`customerId`, `createdAt`),
  INDEX `PrivacyRequest_phone_idx` (`phone`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
