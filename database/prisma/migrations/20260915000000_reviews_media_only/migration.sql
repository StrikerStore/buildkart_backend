-- Customer reviews become photos and videos only.
--
-- `body` is no longer written or shown. It is made nullable rather than
-- dropped: reviews posted before this change keep their words in the table,
-- so a deploy destroys nothing, and dropping the column later is one line.
--
-- Re-runnable as it stands: MODIFY to a definition the column already has is a
-- no-op, so a retry after a partial deploy cannot wedge.
ALTER TABLE `CustomerReview` MODIFY `body` TEXT NULL;
