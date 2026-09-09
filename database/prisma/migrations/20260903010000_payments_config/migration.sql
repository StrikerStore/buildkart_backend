-- PAYU is APPENDED to both enums, never inserted.
--
-- MySQL stores an ENUM value as its 1-based ordinal. Adding a member at the end
-- is an INSTANT metadata change; inserting one in the middle rewrites the table
-- and silently remaps every existing row to a different value.
ALTER TABLE `Order`
  MODIFY `paymentMethod` ENUM('RAZORPAY', 'COD', 'SNAPMINT', 'PAYU') NOT NULL,
  MODIFY `paymentGateway` ENUM('RAZORPAY', 'SNAPMINT', 'CASH', 'UPI_DIRECT', 'BANK_TRANSFER', 'PAYU') NULL;

ALTER TABLE `PaymentTransaction`
  MODIFY `gateway` ENUM('RAZORPAY', 'SNAPMINT', 'CASH', 'UPI_DIRECT', 'BANK_TRANSFER', 'PAYU') NOT NULL;

-- ---------------------------------------------------------------------------
-- The three standalone payment toggles become four provider rows.
--
-- Carried across rather than defaulted, so a shop that had switched Razorpay on
-- does not silently find it off after a deploy. Self-running: there is no
-- deploy-time script anybody has to remember.
-- ---------------------------------------------------------------------------

INSERT INTO `Setting` (`key`, `value`, `updatedAt`)
SELECT 'payments.cod',
       JSON_OBJECT(
         'enabled',       COALESCE(JSON_EXTRACT(`value`, '$.enabled'), CAST('true' AS JSON)),
         'displayName',   'Cash on delivery',
         'displayOrder',  0,
         'maxOrderValue', '0.00'
       ),
       NOW(3)
FROM `Setting` WHERE `key` = 'payments.codEnabled'
ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updatedAt` = NOW(3);

INSERT INTO `Setting` (`key`, `value`, `updatedAt`)
SELECT 'payments.razorpay',
       JSON_OBJECT(
         'enabled',          COALESCE(JSON_EXTRACT(`value`, '$.enabled'), CAST('false' AS JSON)),
         'mode',             'TEST',
         'displayName',      '',
         'displayOrder',     1,
         'keyId',            '',
         'keySecretEnc',     JSON_OBJECT('enc', '', 'hint', ''),
         'webhookSecretEnc', JSON_OBJECT('enc', '', 'hint', '')
       ),
       NOW(3)
FROM `Setting` WHERE `key` = 'payments.razorpayEnabled'
ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updatedAt` = NOW(3);

INSERT INTO `Setting` (`key`, `value`, `updatedAt`)
SELECT 'payments.snapmint',
       JSON_OBJECT(
         'enabled',      COALESCE(JSON_EXTRACT(`value`, '$.enabled'), CAST('false' AS JSON)),
         'mode',         'TEST',
         'displayName',  '',
         'displayOrder', 3,
         'merchantId',   '',
         'apiKeyEnc',    JSON_OBJECT('enc', '', 'hint', '')
       ),
       NOW(3)
FROM `Setting` WHERE `key` = 'payments.snapmintEnabled'
ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updatedAt` = NOW(3);

-- PayU is new, so there is no old row to carry across.
INSERT INTO `Setting` (`key`, `value`, `updatedAt`)
VALUES ('payments.payu',
        JSON_OBJECT(
          'enabled',      CAST('false' AS JSON),
          'mode',         'TEST',
          'displayName',  '',
          'displayOrder', 2,
          'merchantKey',  '',
          'saltEnc',      JSON_OBJECT('enc', '', 'hint', ''),
          'saltV2Enc',    JSON_OBJECT('enc', '', 'hint', '')
        ),
        NOW(3))
ON DUPLICATE KEY UPDATE `key` = `key`;

-- Left until last: everything above reads them.
DELETE FROM `Setting`
 WHERE `key` IN ('payments.codEnabled', 'payments.razorpayEnabled', 'payments.snapmintEnabled');
