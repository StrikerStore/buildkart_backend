-- WhatsApp sending through AiSensy.
--
-- `Customer.whatsappOptIn` is the consent flag: on by default, off when the
-- customer unticks it or replies STOP. `NotificationTemplate` gains the
-- provider's id and approval verdict for templates submitted from the admin.
-- `NotificationMessage` is the outbound log, one row per attempted message,
-- deduplicated by `dedupeKey`.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'whatsappOptIn'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `whatsappOptIn` BOOLEAN NOT NULL DEFAULT true'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'whatsappOptOutAt'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `whatsappOptOutAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationTemplate'
            AND COLUMN_NAME = 'providerTemplateRef'),
  'DO 0',
  'ALTER TABLE `NotificationTemplate` ADD COLUMN `providerTemplateRef` VARCHAR(64) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationTemplate'
            AND COLUMN_NAME = 'providerStatus'),
  'DO 0',
  'ALTER TABLE `NotificationTemplate` ADD COLUMN `providerStatus` VARCHAR(16) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationTemplate'
            AND COLUMN_NAME = 'providerRejectedReason'),
  'DO 0',
  'ALTER TABLE `NotificationTemplate` ADD COLUMN `providerRejectedReason` VARCHAR(255) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS `NotificationMessage` (
  `id`                VARCHAR(191) NOT NULL,
  `event`             VARCHAR(64) NOT NULL,
  `channel`           ENUM('SMS', 'WHATSAPP', 'EMAIL') NOT NULL,
  `locale`            VARCHAR(5) NOT NULL DEFAULT 'en',
  `customerId`        VARCHAR(191) NULL,
  `orderId`           VARCHAR(191) NULL,
  `paymentSessionId`  VARCHAR(191) NULL,
  `phone`             VARCHAR(20) NOT NULL,
  `templateName`      VARCHAR(128) NOT NULL,
  `params`            JSON NOT NULL,
  `status`            ENUM('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'QUEUED',
  `skipReason`        VARCHAR(64) NULL,
  `providerMessageId` VARCHAR(191) NULL,
  `attempts`          INTEGER NOT NULL DEFAULT 0,
  `lastError`         VARCHAR(500) NULL,
  `dedupeKey`         VARCHAR(191) NOT NULL,
  `createdAt`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`         DATETIME(3) NOT NULL,
  `sentAt`            DATETIME(3) NULL,
  `deliveredAt`       DATETIME(3) NULL,
  `readAt`            DATETIME(3) NULL,
  `failedAt`          DATETIME(3) NULL,

  UNIQUE INDEX `NotificationMessage_providerMessageId_key` (`providerMessageId`),
  UNIQUE INDEX `NotificationMessage_dedupeKey_key` (`dedupeKey`),
  INDEX `NotificationMessage_status_createdAt_idx` (`status`, `createdAt`),
  INDEX `NotificationMessage_orderId_idx` (`orderId`),
  INDEX `NotificationMessage_customerId_idx` (`customerId`),
  INDEX `NotificationMessage_createdAt_idx` (`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
