-- An index for the per-address sign-in code limit.
--
-- `issueOtp` now counts the codes sent from one IP address in the last fifteen
-- minutes, across every phone number, so a script walking through numbers is
-- capped. `CustomerOtp.ip` has been recorded since the table was created but
-- never indexed; without this, every code request would scan the table.
--
-- No data changes. Re-runnable, for the reason given in
-- 20260920000000_warehouses_distance_delivery.

SET @stmt := (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'CustomerOtp'
            AND INDEX_NAME = 'CustomerOtp_ip_createdAt_idx'),
  'DO 0',
  'CREATE INDEX `CustomerOtp_ip_createdAt_idx` ON `CustomerOtp`(`ip`, `createdAt`)'));
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
