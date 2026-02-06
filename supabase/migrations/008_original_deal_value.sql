-- Add original_deal_value column to deals table for manual entry of original deal value in renewals
ALTER TABLE deals 
ADD COLUMN IF NOT EXISTS original_deal_value DECIMAL(12,2) NULL;

-- Add comment explaining the column
COMMENT ON COLUMN deals.original_deal_value IS 'Manual entry of original deal value for renewals when original_deal_id is not available or preferred';



