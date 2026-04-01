-- Migration: Add override_payment_date and override_commission_rate to commission_batch_items
-- Allows BDR to override first payment date (for delays) and commission % per line

ALTER TABLE commission_batch_items
ADD COLUMN IF NOT EXISTS override_payment_date DATE;

ALTER TABLE commission_batch_items
ADD COLUMN IF NOT EXISTS override_commission_rate DECIMAL(5,4);

COMMENT ON COLUMN commission_batch_items.override_payment_date IS 'Override revenue/first payment date when funds reflect later than expected';
COMMENT ON COLUMN commission_batch_items.override_commission_rate IS 'Override commission rate (e.g. 0.025 = 2.5%). When set, amount = amount_collected * rate';
