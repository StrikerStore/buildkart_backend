-- `OFFER_STRIP` becomes `HOME_BOTTOM`: a wide banner closing the home page,
-- just above the brand tagline. The offer strip never had a slot on the
-- storefront, so anything saved against it was hidden; it is carried over
-- rather than dropped, keeping the same last ordinal.
--
-- Three steps because MySQL cannot rename an ENUM value in place: widen the
-- column to hold both, move the rows, then narrow it to the new set.

ALTER TABLE `Banner`
  MODIFY `placement` ENUM('HOME_HERO', 'HOME_STRIP', 'CATEGORY_TOP', 'PRODUCT_PAGE', 'OFFER_STRIP', 'HOME_BOTTOM')
  NOT NULL DEFAULT 'HOME_HERO';

UPDATE `Banner` SET `placement` = 'HOME_BOTTOM' WHERE `placement` = 'OFFER_STRIP';

ALTER TABLE `Banner`
  MODIFY `placement` ENUM('HOME_HERO', 'HOME_STRIP', 'CATEGORY_TOP', 'PRODUCT_PAGE', 'HOME_BOTTOM')
  NOT NULL DEFAULT 'HOME_HERO';
