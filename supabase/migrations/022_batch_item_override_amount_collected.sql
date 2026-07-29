-- Per-report override for revenue/net sales amount claimed on (report pull only)
ALTER TABLE commission_batch_items
ADD COLUMN IF NOT EXISTS override_amount_collected DECIMAL(12,2);

COMMENT ON COLUMN commission_batch_items.override_amount_collected IS 'Override amount claimed on for this report line (e.g. net sales for percentage_of_net_sales deals).';
