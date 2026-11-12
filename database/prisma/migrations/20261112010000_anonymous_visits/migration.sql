-- Visits from browsers that have not said yes to analytics, as a bare tally.
--
-- Until now such a visit was not counted at all, so the Analytics page showed
-- far fewer visits than an ad platform's clicks. Each one now adds one to the
-- row for its store day and kind of device. Nothing else is stored: no id, no
-- address, no page, no source — so no row is about anyone.
--
-- Re-runnable, for the reason given in 20260920000000_warehouses_distance_delivery.

CREATE TABLE IF NOT EXISTS `AnonymousVisitDaily` (
  `day`       DATE         NOT NULL,
  `device`    VARCHAR(10)  NOT NULL,
  `visits`    INTEGER      NOT NULL DEFAULT 0,
  `updatedAt` DATETIME(3)  NOT NULL,

  PRIMARY KEY (`day`, `device`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
