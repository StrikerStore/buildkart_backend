-- Messages from the website's Contact us form and requests for a better rate.
--
-- A new table rather than more columns on `SupportTicket`: a ticket needs a
-- customer behind it, and most people sending these have not signed in. The
-- phone is typed, not verified, so nothing here may be treated as an account.
--
-- `ipHash` is a keyed hash, never the address. It exists only so the write can
-- count how many came from one place in the last hour.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

CREATE TABLE IF NOT EXISTS `Enquiry` (
  `id`            VARCHAR(191) NOT NULL,
  `enquiryNumber` VARCHAR(32)  NOT NULL,
  `kind`          VARCHAR(16)  NOT NULL,
  `status`        VARCHAR(16)  NOT NULL DEFAULT 'NEW',
  `name`          VARCHAR(191) NOT NULL,
  `phone`         VARCHAR(20)  NOT NULL,
  `message`       TEXT         NULL,
  `quote`         JSON         NULL,
  `note`          TEXT         NULL,
  `customerId`    VARCHAR(191) NULL,
  `ipHash`        VARCHAR(64)  NULL,
  `closedAt`      DATETIME(3)  NULL,
  `createdAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`     DATETIME(3)  NOT NULL,

  UNIQUE INDEX `Enquiry_enquiryNumber_key` (`enquiryNumber`),
  INDEX `Enquiry_status_createdAt_idx` (`status`, `createdAt`),
  INDEX `Enquiry_phone_createdAt_idx` (`phone`, `createdAt`),
  INDEX `Enquiry_ipHash_createdAt_idx` (`ipHash`, `createdAt`),
  INDEX `Enquiry_customerId_idx` (`customerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'Enquiry'
            AND CONSTRAINT_NAME = 'Enquiry_customerId_fkey'),
  'DO 0',
  'ALTER TABLE `Enquiry` ADD CONSTRAINT `Enquiry_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
