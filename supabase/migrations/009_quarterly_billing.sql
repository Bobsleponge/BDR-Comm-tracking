-- Add quarterly billing type and related fields
-- Update billing_type constraint to include 'quarterly'
ALTER TABLE deal_services 
DROP CONSTRAINT IF EXISTS deal_services_billing_type_check;

ALTER TABLE deal_services 
ADD CONSTRAINT deal_services_billing_type_check 
CHECK (billing_type IN ('one_off', 'mrr', 'deposit', 'quarterly'));

-- Add quarterly_price column
ALTER TABLE deal_services 
ADD COLUMN IF NOT EXISTS quarterly_price DECIMAL(12,2) NULL;

-- Add contract_quarters column
ALTER TABLE deal_services 
ADD COLUMN IF NOT EXISTS contract_quarters INTEGER NOT NULL DEFAULT 4;

-- Add comment explaining the columns
COMMENT ON COLUMN deal_services.quarterly_price IS 'Quarterly price for recurring quarterly billing type';
COMMENT ON COLUMN deal_services.contract_quarters IS 'Number of quarters in the contract for quarterly billing type';





