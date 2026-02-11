-- Add completion_date field for deposit-based billing services
ALTER TABLE deal_services
ADD COLUMN IF NOT EXISTS completion_date DATE;

-- Add index for completion_date queries
CREATE INDEX IF NOT EXISTS idx_deal_services_completion_date ON deal_services(completion_date) WHERE completion_date IS NOT NULL;





