-- Saved lists: a customer's own named lists of materials, for the mobile app.
--
-- Two new tables and nothing else. No existing table gains a column and no
-- write path changes, so the shop runs exactly as before until a customer
-- saves a list. Erasing an account deletes its lists (privacy-erasure.ts);
-- the cascade below covers a customer row that is ever deleted outright.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

CREATE TABLE IF NOT EXISTS `SavedList` (
  `id`         VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `name`       VARCHAR(80)  NOT NULL,
  `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`  DATETIME(3)  NOT NULL,

  INDEX `SavedList_customerId_updatedAt_idx` (`customerId`, `updatedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `SavedListItem` (
  `id`        VARCHAR(191) NOT NULL,
  `listId`    VARCHAR(191) NOT NULL,
  `variantId` VARCHAR(191) NOT NULL,
  `quantity`  INTEGER      NOT NULL,
  `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3)  NOT NULL,

  UNIQUE INDEX `SavedListItem_listId_variantId_key` (`listId`, `variantId`),
  INDEX `SavedListItem_variantId_idx` (`variantId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @stmt = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'SavedList'
            AND CONSTRAINT_NAME = 'SavedList_customerId_fkey'),
  'DO 0',
  'ALTER TABLE `SavedList` ADD CONSTRAINT `SavedList_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'SavedListItem'
            AND CONSTRAINT_NAME = 'SavedListItem_listId_fkey'),
  'DO 0',
  'ALTER TABLE `SavedListItem` ADD CONSTRAINT `SavedListItem_listId_fkey` FOREIGN KEY (`listId`) REFERENCES `SavedList`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

SET @stmt = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'SavedListItem'
            AND CONSTRAINT_NAME = 'SavedListItem_variantId_fkey'),
  'DO 0',
  'ALTER TABLE `SavedListItem` ADD CONSTRAINT `SavedListItem_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
