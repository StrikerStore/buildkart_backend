-- DropForeignKey
ALTER TABLE `category` DROP FOREIGN KEY `Category_autoTagId_fkey`;

-- DropIndex
DROP INDEX `Category_autoTagId_fkey` ON `category`;

-- AlterTable
ALTER TABLE `category` DROP COLUMN `autoTagId`,
    ADD COLUMN `autoMatch` ENUM('ALL', 'ANY') NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE `tag` ALTER COLUMN `updatedAt` DROP DEFAULT;

-- CreateTable
CREATE TABLE `CategoryTagRule` (
    `id` VARCHAR(191) NOT NULL,
    `categoryId` VARCHAR(191) NOT NULL,
    `tagId` VARCHAR(191) NOT NULL,
    `operator` ENUM('INCLUDES', 'EXCLUDES') NOT NULL DEFAULT 'INCLUDES',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CategoryTagRule_tagId_idx`(`tagId`),
    UNIQUE INDEX `CategoryTagRule_categoryId_tagId_operator_key`(`categoryId`, `tagId`, `operator`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CategoryTagRule` ADD CONSTRAINT `CategoryTagRule_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `Category`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CategoryTagRule` ADD CONSTRAINT `CategoryTagRule_tagId_fkey` FOREIGN KEY (`tagId`) REFERENCES `Tag`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
