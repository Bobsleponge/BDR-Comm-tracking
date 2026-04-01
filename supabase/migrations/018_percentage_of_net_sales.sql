-- Migration: Percentage of Net Sales billing type
-- Adds support for billing clients a % of their net sales with monthly reminder commission entries

-- 1. Add billing_percentage to deal_services (nullable, used only for percentage_of_net_sales)
ALTER TABLE deal_services 
ADD COLUMN IF NOT EXISTS billing_percentage DECIMAL(5,4);

-- 2. Add percentage_of_net_sales to billing_type constraint
ALTER TABLE deal_services 
DROP CONSTRAINT IF EXISTS deal_services_billing_type_check;

ALTER TABLE deal_services 
ADD CONSTRAINT deal_services_billing_type_check 
CHECK (billing_type IN ('one_off', 'mrr', 'deposit', 'quarterly', 'paid_on_completion', 'percentage_of_net_sales'));

-- 3. Add service_id to commission_entries (nullable, links placeholder entries to their service)
ALTER TABLE commission_entries 
ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES deal_services(id) ON DELETE SET NULL;

-- 4. Backfill service_id from revenue_events for existing entries
UPDATE commission_entries ce
SET service_id = re.service_id
FROM revenue_events re
WHERE ce.revenue_event_id = re.id AND ce.service_id IS NULL;

-- 5. Allow amount to be NULL (placeholder reminders)
ALTER TABLE commission_entries 
ALTER COLUMN amount DROP NOT NULL;

-- 6. Drop old unique constraint and add new ones to support multiple services per deal per month
-- For entries with service_id: unique per (deal_id, month, service_id)
-- For entries without service_id (legacy): unique per (deal_id, month)
ALTER TABLE commission_entries 
DROP CONSTRAINT IF EXISTS commission_entries_deal_id_month_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_entries_deal_month_service 
ON commission_entries (deal_id, month, service_id) 
WHERE service_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_entries_deal_month_null_service 
ON commission_entries (deal_id, month) 
WHERE service_id IS NULL;

-- 7. Index for service_id lookups
CREATE INDEX IF NOT EXISTS idx_commission_entries_service_id ON commission_entries(service_id);
