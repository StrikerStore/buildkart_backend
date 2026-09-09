-- FAQs become one block of HTML, like the return policy beside them.
--
-- The structured `[{question, answer}]` array was the wrong shape for how the
-- shop actually works: the owner pastes a list of questions and answers in one
-- go, and a repeater that makes them fill four inputs per question turns a
-- paste into twenty tab presses. One rich-text field per language, edited and
-- rendered exactly like the return terms.
--
-- The cost of the change is stated plainly: with free-form HTML the storefront
-- can no longer emit FAQPage structured data for Google, because nothing can
-- reliably tell a question from an answer in a blob of markup.

ALTER TABLE `Product`
    ADD COLUMN `faqsEn` TEXT NULL,
    ADD COLUMN `faqsHi` TEXT NULL;

-- Carry across whatever the structured column already holds, rather than
-- dropping it on the floor. GROUP_CONCAT truncates at 1024 bytes by default,
-- which would silently cut a long FAQ list in half.
SET SESSION group_concat_max_len = 65535;

UPDATE `Product` AS p
JOIN (
    SELECT
        src.id,
        GROUP_CONCAT(
            CONCAT(
                '<h3>',
                REPLACE(REPLACE(REPLACE(jt.questionEn, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                '</h3><p>',
                REPLACE(REPLACE(REPLACE(jt.answerEn, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                '</p>'
            )
            ORDER BY jt.ord SEPARATOR ''
        ) AS html
    FROM `Product` AS src,
         JSON_TABLE(
             src.faqsJson,
             '$[*]' COLUMNS (
                 ord FOR ORDINALITY,
                 questionEn TEXT PATH '$.questionEn',
                 answerEn   TEXT PATH '$.answerEn'
             )
         ) AS jt
    WHERE src.faqsJson IS NOT NULL
      AND jt.questionEn IS NOT NULL
      AND jt.questionEn <> ''
    GROUP BY src.id
) AS converted ON converted.id = p.id
SET p.faqsEn = converted.html;

-- The Hindi side, skipping rows whose Hindi was never filled in — a page of
-- empty <h3></h3> pairs is worse than no Hindi at all.
UPDATE `Product` AS p
JOIN (
    SELECT
        src.id,
        GROUP_CONCAT(
            CONCAT(
                '<h3>',
                REPLACE(REPLACE(REPLACE(jt.questionHi, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                '</h3><p>',
                REPLACE(REPLACE(REPLACE(jt.answerHi, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                '</p>'
            )
            ORDER BY jt.ord SEPARATOR ''
        ) AS html
    FROM `Product` AS src,
         JSON_TABLE(
             src.faqsJson,
             '$[*]' COLUMNS (
                 ord FOR ORDINALITY,
                 questionHi TEXT PATH '$.questionHi',
                 answerHi   TEXT PATH '$.answerHi'
             )
         ) AS jt
    WHERE src.faqsJson IS NOT NULL
      AND jt.questionHi IS NOT NULL
      AND jt.questionHi <> ''
    GROUP BY src.id
) AS converted ON converted.id = p.id
SET p.faqsHi = converted.html;

ALTER TABLE `Product` DROP COLUMN `faqsJson`;
