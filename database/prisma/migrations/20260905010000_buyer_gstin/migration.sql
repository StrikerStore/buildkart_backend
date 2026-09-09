-- The buyer's GSTIN: asked for at checkout, frozen on the order.
--
-- Two columns rather than one join. `Customer.gstin` is a convenience so a
-- contractor who buys weekly types it once; `Order.buyerGstin` is what an
-- invoice is actually raised under, and it must not move when the customer
-- registers a new firm.
--
-- 15 characters exactly, but VARCHAR(15) rather than CHAR(15): a CHAR pads on
-- read and every comparison would then have to trim.

ALTER TABLE `Customer`
    ADD COLUMN `gstin` VARCHAR(15) NULL;

ALTER TABLE `Order`
    ADD COLUMN `buyerGstin` VARCHAR(15) NULL;
