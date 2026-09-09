-- What the shop would tell a customer, and when. Nothing sends these yet — the
-- table exists so the wording and the DLT registration ids are settled before a
-- provider is wired up.
--
-- Collation stated explicitly: MySQL 8 defaults new tables to
-- utf8mb4_0900_ai_ci, and every other table in this schema is unicode_ci.

CREATE TABLE `NotificationTemplate` (
    `id`                 VARCHAR(191) NOT NULL,
    `event`              VARCHAR(64)  NOT NULL,
    `channel`            ENUM('SMS', 'WHATSAPP', 'EMAIL') NOT NULL,
    `locale`             VARCHAR(5)   NOT NULL DEFAULT 'en',
    `subject`            VARCHAR(255) NULL,
    `body`               TEXT         NOT NULL,
    `providerTemplateId` VARCHAR(128) NULL,
    `isActive`           BOOLEAN      NOT NULL DEFAULT false,
    `createdAt`          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`          DATETIME(3)  NOT NULL,

    UNIQUE INDEX `NotificationTemplate_event_channel_locale_key`(`event`, `channel`, `locale`),
    INDEX `NotificationTemplate_event_idx`(`event`),
    INDEX `NotificationTemplate_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Four starting drafts, inactive, so the screen is not empty on first open and
-- the owner edits rather than stares. Deliberately plain: a shop will reword
-- these, and a florid default is harder to edit than a blunt one.
INSERT INTO `NotificationTemplate`
  (`id`, `event`, `channel`, `locale`, `body`, `isActive`, `createdAt`, `updatedAt`) VALUES
  ('nt_order_placed_sms', 'order.placed', 'SMS', 'en',
   'Hi {{customerName}}, we have your order {{orderNumber}} for {{orderTotal}}. We will call to confirm. - {{storeName}}',
   false, NOW(3), NOW(3)),
  ('nt_order_dispatched_sms', 'order.dispatched', 'SMS', 'en',
   'Order {{orderNumber}} has left our yard and arrives {{deliveryPromise}}. Questions? {{supportPhone}}',
   false, NOW(3), NOW(3)),
  ('nt_order_delivered_sms', 'order.delivered', 'SMS', 'en',
   'Order {{orderNumber}} delivered. Thank you for buying from {{storeName}}.',
   false, NOW(3), NOW(3)),
  ('nt_payment_received_sms', 'payment.received', 'SMS', 'en',
   'Received {{amountPaid}} against order {{orderNumber}}. Balance {{amountDue}}. - {{storeName}}',
   false, NOW(3), NOW(3));
