-- App notifications: the phones a customer's notifications go to, their in-app
-- inbox, and price / stock alerts — for the mobile app.
--
-- Three new tables and nothing else. NotificationMessage (the WhatsApp log) and
-- every write path stay as they are: order notifications are added beside the
-- existing dispatch, and alerts are checked by a scheduled job against the
-- price and stock already kept. Erasing an account deletes all three
-- (privacy-erasure.ts); the cascades below cover a customer row deleted outright.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

CREATE TABLE IF NOT EXISTS `PushDevice` (
  `id`         VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `token`      VARCHAR(255) NOT NULL,
  `platform`   VARCHAR(16)  NOT NULL,
  `appVersion` VARCHAR(32)  NULL,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastSeenAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `PushDevice_token_key` (`token`),
  INDEX `PushDevice_customerId_idx` (`customerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `AppNotification` (
  `id`         VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `kind`       VARCHAR(16)  NOT NULL,
  `titleEn`    VARCHAR(191) NOT NULL,
  `titleHi`    VARCHAR(191) NULL,
  `bodyEn`     VARCHAR(500) NOT NULL,
  `bodyHi`     VARCHAR(500) NULL,
  `href`       VARCHAR(255) NULL,
  `dedupeKey`  VARCHAR(191) NOT NULL,
  `readAt`     DATETIME(3)  NULL,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `AppNotification_dedupeKey_key` (`dedupeKey`),
  INDEX `AppNotification_customerId_createdAt_idx` (`customerId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `PriceAlert` (
  `id`                VARCHAR(191)   NOT NULL,
  `customerId`        VARCHAR(191)   NOT NULL,
  `variantId`         VARCHAR(191)   NOT NULL,
  `kind`              VARCHAR(16)    NOT NULL,
  `targetPrice`       DECIMAL(10, 2) NULL,
  `isActive`          BOOLEAN        NOT NULL DEFAULT true,
  `lastNotifiedPrice` DECIMAL(10, 2) NULL,
  `lastNotifiedAt`    DATETIME(3)    NULL,
  `createdAt`         DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`         DATETIME(3)    NOT NULL,

  UNIQUE INDEX `PriceAlert_customerId_variantId_kind_key` (`customerId`, `variantId`, `kind`),
  INDEX `PriceAlert_isActive_idx` (`isActive`),
  INDEX `PriceAlert_variantId_idx` (`variantId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @stmt = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'PushDevice'
            AND CONSTRAINT_NAME = 'PushDevice_customerId_fkey'),
  'DO 0',
  'ALTER TABLE `PushDevice` ADD CONSTRAINT `PushDevice_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'AppNotification'
            AND CONSTRAINT_NAME = 'AppNotification_customerId_fkey'),
  'DO 0',
  'ALTER TABLE `AppNotification` ADD CONSTRAINT `AppNotification_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'PriceAlert'
            AND CONSTRAINT_NAME = 'PriceAlert_customerId_fkey'),
  'DO 0',
  'ALTER TABLE `PriceAlert` ADD CONSTRAINT `PriceAlert_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'PriceAlert'
            AND CONSTRAINT_NAME = 'PriceAlert_variantId_fkey'),
  'DO 0',
  'ALTER TABLE `PriceAlert` ADD CONSTRAINT `PriceAlert_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
