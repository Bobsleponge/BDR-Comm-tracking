-- Add tiered commission fields to commission_rules table
ALTER TABLE commission_rules
ADD COLUMN IF NOT EXISTS tier_1_threshold DECIMAL(12,2) DEFAULT 250000.00,
ADD COLUMN IF NOT EXISTS tier_1_rate DECIMAL(5,4) DEFAULT 0.025,
ADD COLUMN IF NOT EXISTS tier_2_rate DECIMAL(5,4) DEFAULT 0.05,
ADD COLUMN IF NOT EXISTS quarterly_target DECIMAL(12,2) DEFAULT 75000.00,
ADD COLUMN IF NOT EXISTS clawback_days INTEGER DEFAULT 90;

-- Update existing records with default values if they don't have them
UPDATE commission_rules
SET 
  tier_1_threshold = COALESCE(tier_1_threshold, 250000.00),
  tier_1_rate = COALESCE(tier_1_rate, 0.025),
  tier_2_rate = COALESCE(tier_2_rate, 0.05),
  quarterly_target = COALESCE(quarterly_target, 75000.00),
  clawback_days = COALESCE(clawback_days, 90)
WHERE tier_1_threshold IS NULL;





