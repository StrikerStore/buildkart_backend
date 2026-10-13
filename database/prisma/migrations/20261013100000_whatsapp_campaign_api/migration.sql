-- WhatsApp moves from AiSensy's Project API to its Campaign API.
--
-- The Campaign API cannot submit templates, returns no message id and sends no
-- webhooks, so everything that depended on those goes:
--
--   NotificationTemplate: providerTemplateRef, providerStatus,
--     providerRejectedReason (template approval is done in AiSensy now).
--   NotificationMessage: providerMessageId and its unique index, deliveredAt,
--     readAt; DELIVERED and READ leave the status enum (folded into SENT
--     first, so no row is left holding a value the column no longer allows).
--
-- `NotificationMessage.userName` is added: AiSensy requires one on every call,
-- and a retry should send the same name the first attempt did.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationTemplate'
            AND COLUMN_NAME = 'providerTemplateRef'),
  'ALTER TABLE `NotificationTemplate` DROP COLUMN `providerTemplateRef`',
  'DO 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationTemplate'
            AND COLUMN_NAME = 'providerStatus'),
  'ALTER TABLE `NotificationTemplate` DROP COLUMN `providerStatus`',
  'DO 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationTemplate'
            AND COLUMN_NAME = 'providerRejectedReason'),
  'ALTER TABLE `NotificationTemplate` DROP COLUMN `providerRejectedReason`',
  'DO 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationMessage'
            AND INDEX_NAME = 'NotificationMessage_providerMessageId_key'),
  'ALTER TABLE `NotificationMessage` DROP INDEX `NotificationMessage_providerMessageId_key`',
  'DO 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationMessage'
            AND COLUMN_NAME = 'providerMessageId'),
  'ALTER TABLE `NotificationMessage` DROP COLUMN `providerMessageId`',
  'DO 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationMessage'
            AND COLUMN_NAME = 'deliveredAt'),
  'ALTER TABLE `NotificationMessage` DROP COLUMN `deliveredAt`',
  'DO 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationMessage'
            AND COLUMN_NAME = 'readAt'),
  'ALTER TABLE `NotificationMessage` DROP COLUMN `readAt`',
  'DO 0'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationMessage'
            AND COLUMN_NAME = 'userName'),
  'DO 0',
  'ALTER TABLE `NotificationMessage` ADD COLUMN `userName` VARCHAR(191) NOT NULL DEFAULT '''' AFTER `phone`'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Harmless on a re-run: no row can hold either value once the MODIFY below has run.
UPDATE `NotificationMessage` SET `status` = 'SENT' WHERE `status` IN ('DELIVERED', 'READ');

ALTER TABLE `NotificationMessage`
  MODIFY `status` ENUM('QUEUED', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'QUEUED';
