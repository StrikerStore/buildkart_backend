-- Purely additive. Every default is chosen so a catalogue that has never heard
-- of tax prices identically the day after this runs.
--
-- The collation on TaxRate is explicit and must stay that way. MySQL 8 defaults
-- new tables to utf8mb4_0900_ai_ci, but every table in this schema is
-- utf8mb4_unicode_ci, and a foreign key between two columns of differing
-- collation is refused outright (error 3780).

CREATE TABLE `TaxRate` (
    `id`        VARCHAR(191)  NOT NULL,
    `name`      VARCHAR(64)   NOT NULL,
    `percent`   DECIMAL(5, 2) NOT NULL,
    `isDefault` BOOLEAN       NOT NULL DEFAULT false,
    `isActive`  BOOLEAN       NOT NULL DEFAULT true,
    `position`  INTEGER       NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3)   NOT NULL,

    UNIQUE INDEX `TaxRate_name_key`(`name`),
    INDEX `TaxRate_isActive_position_idx`(`isActive`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- `taxInclusive` defaults TRUE, and that default is load-bearing: existing
-- prices were entered as what the customer pays, so defaulting FALSE would
-- silently add 18% to every price in the catalogue.
ALTER TABLE `Product`
    ADD COLUMN `taxRateId`    VARCHAR(191)  NULL,
    ADD COLUMN `taxPercent`   DECIMAL(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `taxInclusive` BOOLEAN       NOT NULL DEFAULT true,
    ADD COLUMN `hsnCode`      VARCHAR(16)   NULL;

CREATE INDEX `Product_taxRateId_idx` ON `Product`(`taxRateId`);

ALTER TABLE `Product`
    ADD CONSTRAINT `Product_taxRateId_fkey`
    FOREIGN KEY (`taxRateId`) REFERENCES `TaxRate`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The five Indian GST slabs, seeded so the dropdown is useful on first open.
-- The owner may rename, reorder, retire or add to these.
INSERT INTO `TaxRate` (`id`, `name`, `percent`, `isDefault`, `isActive`, `position`, `createdAt`, `updatedAt`) VALUES
    ('taxrate_gst_00', 'Nil rated (0%)',  0.00, false, true, 0, NOW(3), NOW(3)),
    ('taxrate_gst_05', 'GST 5%',          5.00, false, true, 1, NOW(3), NOW(3)),
    ('taxrate_gst_12', 'GST 12%',        12.00, false, true, 2, NOW(3), NOW(3)),
    ('taxrate_gst_18', 'GST 18%',        18.00, true,  true, 3, NOW(3), NOW(3)),
    ('taxrate_gst_28', 'GST 28%',        28.00, false, true, 4, NOW(3), NOW(3));
