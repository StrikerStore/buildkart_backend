-- AlterTable
ALTER TABLE `Order` DROP COLUMN `razorpayOrderId`,
    DROP COLUMN `razorpayPaymentId`,
    ADD COLUMN `amountPaid` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `amountRefunded` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `paidAt` DATETIME(3) NULL,
    ADD COLUMN `paymentGateway` ENUM('RAZORPAY', 'SNAPMINT', 'CASH', 'UPI_DIRECT', 'BANK_TRANSFER') NULL,
    ADD COLUMN `paymentInstrument` ENUM('UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI', 'CASH', 'OTHER') NULL,
    ADD COLUMN `paymentReference` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `PaymentTransaction` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `type` ENUM('PAYMENT', 'REFUND') NOT NULL,
    `status` ENUM('PENDING', 'AUTHORIZED', 'SUCCESS', 'FAILED') NOT NULL,
    `gateway` ENUM('RAZORPAY', 'SNAPMINT', 'CASH', 'UPI_DIRECT', 'BANK_TRANSFER') NOT NULL,
    `instrument` ENUM('UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI', 'CASH', 'OTHER') NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `reference` VARCHAR(191) NULL,
    `gatewayOrderId` VARCHAR(191) NULL,
    `failureReason` VARCHAR(255) NULL,
    `instrumentDetail` JSON NULL,
    `note` VARCHAR(255) NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `recordedByAdminId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PaymentTransaction_orderId_occurredAt_idx`(`orderId`, `occurredAt`),
    INDEX `PaymentTransaction_reference_idx`(`reference`),
    INDEX `PaymentTransaction_status_occurredAt_idx`(`status`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Order_paymentReference_idx` ON `Order`(`paymentReference`);

-- AddForeignKey
ALTER TABLE `PaymentTransaction` ADD CONSTRAINT `PaymentTransaction_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentTransaction` ADD CONSTRAINT `PaymentTransaction_recordedByAdminId_fkey` FOREIGN KEY (`recordedByAdminId`) REFERENCES `AdminUser`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
