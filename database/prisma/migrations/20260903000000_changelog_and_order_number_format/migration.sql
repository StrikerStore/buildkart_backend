-- The change log filters by action group with no entity in hand, which the
-- three existing indexes on this table cannot serve.
CREATE INDEX `AdminAuditLog_action_createdAt_idx` ON `AdminAuditLog`(`action`, `createdAt`);

-- The owner now sets a prefix, a suffix and a padding width for order numbers.
-- 20 characters could truncate, and a truncated order number is a collision.
ALTER TABLE `Order` MODIFY `orderNumber` VARCHAR(32) NOT NULL;
