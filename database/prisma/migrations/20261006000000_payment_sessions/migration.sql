-- Online payments through Razorpay and PayU.
--
-- An online order is written only after the gateway confirms the money, so the
-- cart-being-paid-for lives in `PaymentSession` until then: the frozen order
-- payload, the amount charged, and the gateway's own order id. Whichever of the
-- four confirmation paths arrives first claims the row and writes the order.
--
-- `CustomerGatewayAccount` maps a customer to their Razorpay `cust_...`, which
-- is what that gateway's saved cards belong to.
--
-- `PAYLATER` is appended to the instrument enum (Simpl, LazyPay and the like).
-- Appended, never inserted: MySQL stores an ENUM as its ordinal.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery:
-- MySQL has no transactional DDL, so every statement tolerates having run.

ALTER TABLE `Order`
  MODIFY `paymentInstrument` ENUM('UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI', 'CASH', 'OTHER', 'PAYLATER') NULL;

ALTER TABLE `PaymentTransaction`
  MODIFY `instrument` ENUM('UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI', 'CASH', 'OTHER', 'PAYLATER') NULL;

-- Child first.
DROP TABLE IF EXISTS `CustomerGatewayAccount`;
DROP TABLE IF EXISTS `PaymentSession`;

CREATE TABLE `PaymentSession` (
  `id`               VARCHAR(191) NOT NULL,
  `customerId`       VARCHAR(191) NOT NULL,
  `status`           ENUM('CREATED', 'FINALIZING', 'ORDER_CREATED', 'FAILED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED') NOT NULL DEFAULT 'CREATED',
  `option`           VARCHAR(16) NOT NULL,
  `gateway`          ENUM('RAZORPAY', 'SNAPMINT', 'CASH', 'UPI_DIRECT', 'BANK_TRANSFER', 'PAYU', 'STORE_CREDIT') NOT NULL,
  `instrument`       ENUM('UPI', 'CARD', 'NETBANKING', 'WALLET', 'EMI', 'CASH', 'OTHER', 'PAYLATER') NULL,
  `amount`           DECIMAL(10, 2) NOT NULL,
  `grandTotal`       DECIMAL(10, 2) NOT NULL,
  `walletQuoted`     DECIMAL(10, 2) NOT NULL DEFAULT 0,
  `payload`          JSON NOT NULL,
  `gatewayOrderId`   VARCHAR(64) NULL,
  `gatewayPaymentId` VARCHAR(64) NULL,
  `orderId`          VARCHAR(191) NULL,
  `failureReason`    VARCHAR(255) NULL,
  `expiresAt`        DATETIME(3) NOT NULL,
  `createdAt`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`        DATETIME(3) NOT NULL,

  UNIQUE INDEX `PaymentSession_gatewayOrderId_key` (`gatewayOrderId`),
  UNIQUE INDEX `PaymentSession_orderId_key` (`orderId`),
  INDEX `PaymentSession_status_createdAt_idx` (`status`, `createdAt`),
  INDEX `PaymentSession_customerId_createdAt_idx` (`customerId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CustomerGatewayAccount` (
  `id`         VARCHAR(191) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `gateway`    ENUM('RAZORPAY', 'SNAPMINT', 'CASH', 'UPI_DIRECT', 'BANK_TRANSFER', 'PAYU', 'STORE_CREDIT') NOT NULL,
  `externalId` VARCHAR(64) NOT NULL,
  `createdAt`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CustomerGatewayAccount_customerId_gateway_key` (`customerId`, `gateway`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PaymentSession`
  ADD CONSTRAINT `PaymentSession_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PaymentSession`
  ADD CONSTRAINT `PaymentSession_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CustomerGatewayAccount`
  ADD CONSTRAINT `CustomerGatewayAccount_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
