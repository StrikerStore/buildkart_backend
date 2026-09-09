-- The trust strip becomes a homepage section.
--
-- No schema change: `HomepageSection.type` is a VARCHAR plus a zod union
-- precisely so a new kind of band costs no ALTER on a live table, and the new
-- `markers` key lives inside the existing `configJson`.
--
-- What this migration does is carry the *page* across. Until now the strip was
-- rendered unconditionally by the storefront, between the banner block and the
-- merchandising below it. After this deploy the page renders only what the
-- sections table says, so a shop that upgrades without a row here would lose
-- the strip silently — the worst kind of regression, because nothing errors and
-- the only symptom is a promise that stopped being made.
--
-- User variables rather than a self-referencing UPDATE: MySQL refuses to update
-- a table while a subquery in the same statement reads it, and the two reads
-- here (where the banner strip sits, whether a trust strip already exists) both
-- target the table being written.

-- Where the strip has been rendering: immediately after the banner strip, or
-- directly under the hero when there is no banner strip.
SET @insertAt := IFNULL((SELECT MIN(`position`) + 1 FROM `HomepageSection` WHERE `type` = 'BANNER_STRIP'), 0);

-- Two guards. An existing TRUST_STRIP row means this already ran. An empty
-- table means a fresh install with no home page yet — the seed builds one, and
-- a lone strip inserted here would collide with the positions it assigns.
SET @shouldInsert := (
  SELECT CASE WHEN COUNT(*) = 0 THEN 0
              WHEN SUM(`type` = 'TRUST_STRIP') > 0 THEN 0
              ELSE 1 END
  FROM `HomepageSection`
);

UPDATE `HomepageSection`
   SET `position` = `position` + 1
 WHERE @shouldInsert = 1 AND `position` >= @insertAt;

INSERT INTO `HomepageSection`
  (`id`, `type`, `titleEn`, `titleHi`, `configJson`, `position`, `isActive`, `createdAt`, `updatedAt`)
SELECT 'seed00000000000truststrip',
       'TRUST_STRIP',
       NULL,
       NULL,
       -- All four, which is what the hard-coded strip was showing. The COD tile
       -- still hides itself at render time when cash on delivery is switched
       -- off, exactly as it did before.
       JSON_OBJECT('markers', JSON_ARRAY('fast', 'cod', 'genuine', 'rates')),
       @insertAt,
       1,
       NOW(3),
       NOW(3)
  FROM DUAL
 WHERE @shouldInsert = 1;
