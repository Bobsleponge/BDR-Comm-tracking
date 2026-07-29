-- Previous billing % for renewal percentage-of-net-sales (uplift commission)
ALTER TABLE deal_services
ADD COLUMN IF NOT EXISTS original_billing_percentage DECIMAL(5,4);

COMMENT ON COLUMN deal_services.original_billing_percentage IS 'Prior billing % for renewal pct-of-net-sales; commission uses (billing_percentage - this) × claimed × base_rate.';
