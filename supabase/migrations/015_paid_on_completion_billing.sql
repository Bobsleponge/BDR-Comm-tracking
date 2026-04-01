-- Add paid_on_completion billing type
-- Update billing_type constraint to include 'paid_on_completion'
ALTER TABLE deal_services 
DROP CONSTRAINT IF EXISTS deal_services_billing_type_check;

ALTER TABLE deal_services 
ADD CONSTRAINT deal_services_billing_type_check 
CHECK (billing_type IN ('one_off', 'mrr', 'deposit', 'quarterly', 'paid_on_completion'));
