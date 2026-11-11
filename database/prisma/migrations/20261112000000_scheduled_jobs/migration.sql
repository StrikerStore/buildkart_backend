-- The API's own scheduler: one row per scheduled job.
--
-- The jobs behind /cron/* used to wait for something outside to call them, and
-- nothing did. The API now runs them itself (core/src/scheduler.ts). Each row
-- holds the time slot the job last claimed and a lease, so a redeploy's old and
-- new process, or two replicas, never start the same run twice.
--
-- Rows are created by the scheduler when it starts; nothing to seed.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

CREATE TABLE IF NOT EXISTS `ScheduledJob` (
  `name`        VARCHAR(40)  NOT NULL,
  `slot`        DATETIME(3)  NULL,
  `attempts`    INTEGER      NOT NULL DEFAULT 0,
  `lockedUntil` DATETIME(3)  NULL,
  `lockedBy`    VARCHAR(64)  NULL,
  `startedAt`   DATETIME(3)  NULL,
  `finishedAt`  DATETIME(3)  NULL,
  `lastOk`      BOOLEAN      NULL,
  `lastOkAt`    DATETIME(3)  NULL,
  `lastError`   VARCHAR(500) NULL,
  `lastResult`  JSON         NULL,
  `updatedAt`   DATETIME(3)  NOT NULL,

  PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
