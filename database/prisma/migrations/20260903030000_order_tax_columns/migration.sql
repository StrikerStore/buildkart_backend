-- What each order was actually charged, frozen with the order.

ALTER TABLE `Order`
    ADD COLUMN `taxTotal`      DECIMAL(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `taxAddedTotal` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `taxBreakdown`  JSON           NULL,
    ADD COLUMN `taxInclusive`  BOOLEAN        NOT NULL DEFAULT true,
    ADD COLUMN `taxIntraState` BOOLEAN        NOT NULL DEFAULT true;

ALTER TABLE `OrderItem`
    ADD COLUMN `taxPercent`    DECIMAL(5, 2)  NOT NULL DEFAULT 0,
    ADD COLUMN `taxInclusive`  BOOLEAN        NOT NULL DEFAULT true,
    ADD COLUMN `discountShare` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `taxableAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `taxAmount`     DECIMAL(10, 2) NOT NULL DEFAULT 0;

-- A zero here would read as "nothing on this line was taxable" rather than
-- "nothing on this line was taxed". For every order placed before GST existed,
-- the whole line was the taxable value at a rate of nil.
UPDATE `OrderItem` SET `taxableAmount` = `lineTotal`;
