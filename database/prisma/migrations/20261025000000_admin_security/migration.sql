-- Safeguards: two-step sign-in for the admin, and a record of each breach.
--
-- The `AdminUser.totp*` columns hold an authenticator-app secret (sealed with
-- SETTINGS_ENCRYPTION_KEY, never in the clear), one being set up, the last
-- code step accepted, and hashes of the unused recovery codes. Nothing is
-- backfilled: every admin starts without it, and an owner is asked to set it
-- up at their next sign-in.
--
-- `PrivacyIncident` is the record of a personal data breach (DPDP Rules 2025,
-- rule 7): what customers were told, when the Data Protection Board was told,
-- and the shop's notes. No foreign keys — the record must outlive the admin
-- who wrote it.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AdminUser'
            AND COLUMN_NAME = 'totpSecretEnc'),
  'DO 0',
  'ALTER TABLE `AdminUser` ADD COLUMN `totpSecretEnc` TEXT NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AdminUser'
            AND COLUMN_NAME = 'totpPendingEnc'),
  'DO 0',
  'ALTER TABLE `AdminUser` ADD COLUMN `totpPendingEnc` TEXT NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AdminUser'
            AND COLUMN_NAME = 'totpEnabledAt'),
  'DO 0',
  'ALTER TABLE `AdminUser` ADD COLUMN `totpEnabledAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AdminUser'
            AND COLUMN_NAME = 'totpLastStep'),
  'DO 0',
  'ALTER TABLE `AdminUser` ADD COLUMN `totpLastStep` INTEGER NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AdminUser'
            AND COLUMN_NAME = 'totpRecoveryHashes'),
  'DO 0',
  'ALTER TABLE `AdminUser` ADD COLUMN `totpRecoveryHashes` JSON NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS `PrivacyIncident` (
  `id`                   VARCHAR(191) NOT NULL,
  `title`                VARCHAR(191) NOT NULL,
  `status`               VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
  `whatHappened`         TEXT         NOT NULL,
  `whenHappened`         VARCHAR(191) NOT NULL,
  `dataAffected`         TEXT         NOT NULL,
  `likelyImpact`         TEXT         NOT NULL,
  `measuresTaken`        TEXT         NOT NULL,
  `customerSteps`        TEXT         NOT NULL,
  `detectedAt`           DATETIME(3)  NOT NULL,
  `boardNotifiedAt`      DATETIME(3)  NULL,
  `boardReportAt`        DATETIME(3)  NULL,
  `boardReference`       VARCHAR(191) NULL,
  `notes`                TEXT         NULL,
  `audience`             JSON         NULL,
  `principalsNotifiedAt` DATETIME(3)  NULL,
  `notifiedCount`        INTEGER      NOT NULL DEFAULT 0,
  `createdById`          VARCHAR(191) NULL,
  `createdAt`            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`            DATETIME(3)  NOT NULL,

  INDEX `PrivacyIncident_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
