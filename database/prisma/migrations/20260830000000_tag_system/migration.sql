-- AlterTable
ALTER TABLE `category` ADD COLUMN `autoTagId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `tag` ADD COLUMN `badgeLabelEn` VARCHAR(64) NULL,
    ADD COLUMN `badgeLabelHi` VARCHAR(64) NULL,
    ADD COLUMN `badgeTone` ENUM('NEUTRAL', 'BRAND', 'SUCCESS', 'WARNING', 'CRITICAL', 'INFO') NOT NULL DEFAULT 'NEUTRAL',
    ADD COLUMN `description` VARCHAR(500) NULL,
    ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `position` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `scope` ENUM('INTERNAL', 'PUBLIC') NOT NULL DEFAULT 'INTERNAL',
    ADD COLUMN `showAsBadge` BOOLEAN NOT NULL DEFAULT false,
    -- Backfilled for rows that already exist; a NOT NULL datetime with no
    -- default fails on a populated table under strict mode.
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateIndex
CREATE INDEX `Tag_scope_position_idx` ON `Tag`(`scope`, `position`);

-- CreateIndex
CREATE INDEX `Tag_showAsBadge_isActive_idx` ON `Tag`(`showAsBadge`, `isActive`);

-- AddForeignKey
ALTER TABLE `Category` ADD CONSTRAINT `Category_autoTagId_fkey` FOREIGN KEY (`autoTagId`) REFERENCES `Tag`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
