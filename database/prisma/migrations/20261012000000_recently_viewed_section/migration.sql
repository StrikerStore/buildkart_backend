-- "Recently viewed" becomes a homepage section.
--
-- No schema change, for the reason the trust strip's migration gives:
-- `HomepageSection.type` is a VARCHAR plus a zod union, so a new kind of band
-- costs no ALTER on a live table. The rail needs no config at all — its
-- products are each shopper's own, read from their cookie by the storefront.
--
-- What this migration carries across is the *page*. Until now the storefront
-- rendered the rail unconditionally, after every section the owner arranged.
-- After this deploy it renders only where a row says, so a shop that upgrades
-- without one would lose the rail silently.
--
-- User variables rather than a self-referencing INSERT … SELECT: MySQL refuses
-- to write a table while a subquery in the same statement reads it.

-- Where the rail has been rendering: after every section, active or not, so
-- switching a hidden section back on later does not land it below the rail.
SET @insertAt := (SELECT IFNULL(MAX(`position`), -1) + 1 FROM `HomepageSection`);

-- Two guards. An existing RECENTLY_VIEWED row means this already ran. An empty
-- table means a fresh install with no home page yet — the seed builds one.
SET @shouldInsert := (
  SELECT CASE WHEN COUNT(*) = 0 THEN 0
              WHEN SUM(`type` = 'RECENTLY_VIEWED') > 0 THEN 0
              ELSE 1 END
  FROM `HomepageSection`
);

INSERT INTO `HomepageSection`
  (`id`, `type`, `titleEn`, `titleHi`, `configJson`, `position`, `isActive`, `createdAt`, `updatedAt`)
SELECT 'seed000000000recentlyviewed',
       'RECENTLY_VIEWED',
       -- Null so the storefront's own translated heading is used, which is
       -- what the hard-coded rail was showing.
       NULL,
       NULL,
       JSON_OBJECT('limit', 12),
       @insertAt,
       1,
       NOW(3),
       NOW(3)
  FROM DUAL
 WHERE @shouldInsert = 1;
