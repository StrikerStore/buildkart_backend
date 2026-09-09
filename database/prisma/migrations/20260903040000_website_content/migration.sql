-- Pages, menus and the blog: the words the storefront says that are not a
-- product. Purely additive.
--
-- Every table states COLLATE utf8mb4_unicode_ci explicitly. MySQL 8 defaults
-- new tables to utf8mb4_0900_ai_ci, which cannot carry a foreign key to the
-- existing tables (error 3780).

-- Appended, never inserted: MySQL stores an ENUM value as its ordinal.
ALTER TABLE `Banner`
  MODIFY `placement` ENUM('HOME_HERO', 'HOME_STRIP', 'CATEGORY_TOP', 'PRODUCT_PAGE', 'OFFER_STRIP')
  NOT NULL DEFAULT 'HOME_HERO';

CREATE TABLE `Page` (
    `id`             VARCHAR(191) NOT NULL,
    `slug`           VARCHAR(191) NOT NULL,
    `kind`           VARCHAR(32)  NOT NULL DEFAULT 'STANDARD',
    `titleEn`        VARCHAR(255) NOT NULL,
    `titleHi`        VARCHAR(255) NULL,
    `bodyHtmlEn`     LONGTEXT     NULL,
    `bodyHtmlHi`     LONGTEXT     NULL,
    `seoTitle`       VARCHAR(255) NULL,
    `seoDescription` VARCHAR(320) NULL,
    `isPublished`    BOOLEAN      NOT NULL DEFAULT false,
    `publishedAt`    DATETIME(3)  NULL,
    `position`       INTEGER      NOT NULL DEFAULT 0,
    `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`      DATETIME(3)  NOT NULL,

    UNIQUE INDEX `Page_slug_key`(`slug`),
    INDEX `Page_kind_position_idx`(`kind`, `position`),
    INDEX `Page_isPublished_position_idx`(`isPublished`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Menu` (
    `id`        VARCHAR(191) NOT NULL,
    `handle`    VARCHAR(64)  NOT NULL,
    `nameEn`    VARCHAR(191) NOT NULL,
    `nameHi`    VARCHAR(191) NULL,
    `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3)  NOT NULL,

    UNIQUE INDEX `Menu_handle_key`(`handle`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `MenuItem` (
    `id`         VARCHAR(191) NOT NULL,
    `menuId`     VARCHAR(191) NOT NULL,
    `parentId`   VARCHAR(191) NULL,
    `labelEn`    VARCHAR(191) NOT NULL,
    `labelHi`    VARCHAR(191) NULL,
    `targetKind` VARCHAR(32)  NOT NULL,
    `targetId`   VARCHAR(64)  NULL,
    `url`        VARCHAR(512) NOT NULL,
    `position`   INTEGER      NOT NULL DEFAULT 0,
    `isActive`   BOOLEAN      NOT NULL DEFAULT true,
    `createdAt`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`  DATETIME(3)  NOT NULL,

    INDEX `MenuItem_menuId_parentId_position_idx`(`menuId`, `parentId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `BlogPost` (
    `id`             VARCHAR(191) NOT NULL,
    `slug`           VARCHAR(191) NOT NULL,
    `titleEn`        VARCHAR(255) NOT NULL,
    `titleHi`        VARCHAR(255) NULL,
    `excerptEn`      VARCHAR(500) NULL,
    `excerptHi`      VARCHAR(500) NULL,
    `bodyHtmlEn`     LONGTEXT     NULL,
    `bodyHtmlHi`     LONGTEXT     NULL,
    `coverMediaId`   VARCHAR(191) NULL,
    `authorName`     VARCHAR(191) NULL,
    `seoTitle`       VARCHAR(255) NULL,
    `seoDescription` VARCHAR(320) NULL,
    `isPublished`    BOOLEAN      NOT NULL DEFAULT false,
    `publishedAt`    DATETIME(3)  NULL,
    `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`      DATETIME(3)  NOT NULL,

    UNIQUE INDEX `BlogPost_slug_key`(`slug`),
    INDEX `BlogPost_isPublished_publishedAt_idx`(`isPublished`, `publishedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MenuItem`
  ADD CONSTRAINT `MenuItem_menuId_fkey` FOREIGN KEY (`menuId`) REFERENCES `Menu`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MenuItem`
  ADD CONSTRAINT `MenuItem_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `MenuItem`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `BlogPost`
  ADD CONSTRAINT `BlogPost_coverMediaId_fkey` FOREIGN KEY (`coverMediaId`) REFERENCES `Media`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The menus the storefront asks for by handle, and the policy pages a payment
-- gateway asks to see. Seeded as unpublished drafts so the owner edits rather
-- than remembers — and so the storefront can assume the handles exist.
INSERT INTO `Menu` (`id`, `handle`, `nameEn`, `createdAt`, `updatedAt`) VALUES
    ('menu_header', 'header', 'Header', NOW(3), NOW(3)),
    ('menu_footer', 'footer', 'Footer', NOW(3), NOW(3)),
    ('menu_mobile', 'mobile', 'Mobile menu', NOW(3), NOW(3));

INSERT INTO `Page` (`id`, `slug`, `kind`, `titleEn`, `isPublished`, `position`, `createdAt`, `updatedAt`) VALUES
    ('page_privacy',  'privacy-policy',       'POLICY',   'Privacy policy',      false, 100, NOW(3), NOW(3)),
    ('page_terms',    'terms-and-conditions', 'POLICY',   'Terms and conditions', false, 200, NOW(3), NOW(3)),
    ('page_refund',   'refund-policy',        'POLICY',   'Refund policy',       false, 300, NOW(3), NOW(3)),
    ('page_shipping', 'shipping-policy',      'POLICY',   'Shipping policy',     false, 400, NOW(3), NOW(3)),
    ('page_about',    'about-us',             'STANDARD', 'About us',            false, 500, NOW(3), NOW(3)),
    ('page_contact',  'contact-us',           'STANDARD', 'Contact us',          false, 600, NOW(3), NOW(3)),
    ('page_faq',      'faq',                  'STANDARD', 'FAQs',                false, 700, NOW(3), NOW(3));
