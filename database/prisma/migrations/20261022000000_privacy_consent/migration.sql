-- Consent, recorded the way the DPDP Act asks for it.
--
-- `ConsentRecord` is the append-only history: who agreed to what, under which
-- version of the Privacy Notice, and where. The columns below are the current
-- answers, so a send or a report can check them without reading the history.
--
-- Nothing is backfilled, on purpose. An existing customer has not ticked
-- "offers on WhatsApp", so `whatsappMarketing` starts false for everyone; no
-- review has a recorded agreement to be shown, so `publishConsentAt` starts
-- null (reviews already on the site keep showing until edited, and the owner
-- confirms them); no past order has consent answers, so the Conversions API
-- sweep skips them.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'whatsappMarketing'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `whatsappMarketing` BOOLEAN NOT NULL DEFAULT false'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'whatsappMarketingAt'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `whatsappMarketingAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'analyticsConsent'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `analyticsConsent` BOOLEAN NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'adsConsent'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `adsConsent` BOOLEAN NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'consentUpdatedAt'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `consentUpdatedAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'ageConfirmedAt'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `ageConfirmedAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Customer'
            AND COLUMN_NAME = 'noticeVersion'),
  'DO 0',
  'ALTER TABLE `Customer` ADD COLUMN `noticeVersion` VARCHAR(16) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderAttribution'
            AND COLUMN_NAME = 'analyticsConsent'),
  'DO 0',
  'ALTER TABLE `OrderAttribution` ADD COLUMN `analyticsConsent` BOOLEAN NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderAttribution'
            AND COLUMN_NAME = 'adsConsent'),
  'DO 0',
  'ALTER TABLE `OrderAttribution` ADD COLUMN `adsConsent` BOOLEAN NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PincodeRequest'
            AND COLUMN_NAME = 'consentAt'),
  'DO 0',
  'ALTER TABLE `PincodeRequest` ADD COLUMN `consentAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'CustomerReview'
            AND COLUMN_NAME = 'publishConsentAt'),
  'DO 0',
  'ALTER TABLE `CustomerReview` ADD COLUMN `publishConsentAt` DATETIME(3) NULL'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS `ConsentRecord` (
  `id`            VARCHAR(191) NOT NULL,
  `customerId`    VARCHAR(191) NULL,
  `subjectId`     VARCHAR(64)  NULL,
  `phone`         VARCHAR(20)  NULL,
  `purpose`       VARCHAR(32)  NOT NULL,
  `granted`       BOOLEAN      NOT NULL,
  `noticeVersion` VARCHAR(16)  NOT NULL,
  `source`        VARCHAR(16)  NOT NULL,
  `createdAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `ConsentRecord_customerId_purpose_createdAt_idx` (`customerId`, `purpose`, `createdAt`),
  INDEX `ConsentRecord_subjectId_idx` (`subjectId`),
  INDEX `ConsentRecord_phone_idx` (`phone`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
