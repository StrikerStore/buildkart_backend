-- Support conversations.
--
-- Three tables: the ticket, its messages, and the canned replies the owner
-- answers with. Customers must be signed in to open one, so there is no guest
-- branch here — `customerId` is NOT NULL and RESTRICT, exactly like `Order`.
--
-- `SupportMessage.id` is VARCHAR(26), not the usual VARCHAR(191): it holds a
-- ULID assigned in application code rather than a cuid. The message poll asks
-- for "everything after id X" and orders by id, which is only correct if ids
-- sort by creation time. That is what buys the polling transport its exactness
-- without a per-ticket sequence column and the transaction that would need.

-- CreateTable
CREATE TABLE `SupportTicket` (
    `id` VARCHAR(191) NOT NULL,
    `ticketNumber` VARCHAR(32) NOT NULL,
    `customerId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `topic` VARCHAR(32) NOT NULL,
    `status` ENUM('OPEN', 'WAITING_ON_CUSTOMER', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `lastMessageAt` DATETIME(3) NOT NULL,
    `lastMessageFrom` ENUM('CUSTOMER', 'ADMIN') NOT NULL,
    `customerLastReadAt` DATETIME(3) NULL,
    `adminLastReadAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolvedByAdminId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SupportTicket_ticketNumber_key`(`ticketNumber`),
    INDEX `SupportTicket_status_lastMessageFrom_lastMessageAt_idx`(`status`, `lastMessageFrom`, `lastMessageAt`),
    INDEX `SupportTicket_customerId_lastMessageAt_idx`(`customerId`, `lastMessageAt`),
    INDEX `SupportTicket_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SupportMessage` (
    `id` VARCHAR(26) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `authorRole` ENUM('CUSTOMER', 'ADMIN') NOT NULL,
    `authorAdminId` VARCHAR(191) NULL,
    `body` TEXT NOT NULL,
    `attachmentR2Key` VARCHAR(255) NULL,
    `attachmentMime` VARCHAR(64) NULL,
    `attachmentSizeBytes` INTEGER NULL,
    `attachmentWidth` INTEGER NULL,
    `attachmentHeight` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SupportMessage_ticketId_id_idx`(`ticketId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SupportCannedReply` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `bodyEn` TEXT NOT NULL,
    `bodyHi` TEXT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SupportCannedReply_isActive_position_idx`(`isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SupportTicket` ADD CONSTRAINT `SupportTicket_customerId_fkey` FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupportTicket` ADD CONSTRAINT `SupportTicket_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupportMessage` ADD CONSTRAINT `SupportMessage_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `SupportTicket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupportMessage` ADD CONSTRAINT `SupportMessage_authorAdminId_fkey` FOREIGN KEY (`authorAdminId`) REFERENCES `AdminUser`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
