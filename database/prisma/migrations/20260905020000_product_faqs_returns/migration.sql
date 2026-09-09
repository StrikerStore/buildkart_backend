-- Per-product FAQs and return terms.
--
-- Both nullable with no default: a product that has never been asked anything
-- has no FAQ block, and NULL says that where an empty JSON array would claim
-- the owner had considered it and decided on none.

ALTER TABLE `Product`
    ADD COLUMN `faqsJson`       JSON NULL,
    ADD COLUMN `returnPolicyEn` TEXT NULL,
    ADD COLUMN `returnPolicyHi` TEXT NULL;
