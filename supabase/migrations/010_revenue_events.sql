-- Migration: Revenue Events System
-- This migration introduces revenue_events table and updates commission system
-- to calculate commission strictly on revenue collection events

-- Create revenue_events table
CREATE TABLE IF NOT EXISTS revenue_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  service_id UUID REFERENCES deal_services(id) ON DELETE SET NULL,
  bdr_id UUID NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
  amount_collected DECIMAL(12,2) NOT NULL,
  collection_date DATE NOT NULL,
  billing_type TEXT NOT NULL CHECK (billing_type IN ('one_off', 'monthly', 'quarterly', 'renewal')),
  payment_stage TEXT NOT NULL CHECK (payment_stage IN ('invoice', 'completion', 'renewal', 'scheduled')),
  commissionable BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for revenue_events
CREATE INDEX IF NOT EXISTS idx_revenue_events_deal_id ON revenue_events(deal_id);
CREATE INDEX IF NOT EXISTS idx_revenue_events_service_id ON revenue_events(service_id);
CREATE INDEX IF NOT EXISTS idx_revenue_events_bdr_id ON revenue_events(bdr_id);
CREATE INDEX IF NOT EXISTS idx_revenue_events_collection_date ON revenue_events(collection_date);
CREATE INDEX IF NOT EXISTS idx_revenue_events_billing_type ON revenue_events(billing_type);

-- Update commission_entries table
-- Add new columns for revenue event linking and date tracking
ALTER TABLE commission_entries 
ADD COLUMN IF NOT EXISTS revenue_event_id UUID REFERENCES revenue_events(id) ON DELETE SET NULL;

ALTER TABLE commission_entries 
ADD COLUMN IF NOT EXISTS accrual_date DATE;

ALTER TABLE commission_entries 
ADD COLUMN IF NOT EXISTS payable_date DATE;

-- Update status enum to include 'accrued'
-- First, drop the existing constraint
ALTER TABLE commission_entries 
DROP CONSTRAINT IF EXISTS commission_entries_status_check;

-- Add new constraint with 'accrued' status
ALTER TABLE commission_entries 
ADD CONSTRAINT commission_entries_status_check 
CHECK (status IN ('accrued', 'pending', 'payable', 'paid', 'cancelled'));

-- Create index for new columns
CREATE INDEX IF NOT EXISTS idx_commission_entries_revenue_event_id ON commission_entries(revenue_event_id);
CREATE INDEX IF NOT EXISTS idx_commission_entries_accrual_date ON commission_entries(accrual_date);
CREATE INDEX IF NOT EXISTS idx_commission_entries_payable_date ON commission_entries(payable_date);

-- Update commission_rules table
-- Add payout_delay_days column
ALTER TABLE commission_rules 
ADD COLUMN IF NOT EXISTS payout_delay_days INTEGER NOT NULL DEFAULT 30;

-- Add comment for deprecated field
COMMENT ON COLUMN commission_rules.payout_months_default IS 'DEPRECATED: Use revenue_events system instead. Kept for migration purposes only.';

-- Update bdr_reps table
-- Add allow_trailing_commission and leave_date columns
ALTER TABLE bdr_reps 
ADD COLUMN IF NOT EXISTS allow_trailing_commission BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE bdr_reps 
ADD COLUMN IF NOT EXISTS leave_date DATE;

-- Create trigger for updated_at on revenue_events
CREATE TRIGGER update_revenue_events_updated_at BEFORE UPDATE ON revenue_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add comments for documentation
COMMENT ON TABLE revenue_events IS 'Tracks actual revenue collection events. Commission is calculated only when revenue is collected.';
COMMENT ON COLUMN revenue_events.amount_collected IS 'Amount of revenue collected on this date';
COMMENT ON COLUMN revenue_events.collection_date IS 'Date when revenue was actually collected';
COMMENT ON COLUMN revenue_events.billing_type IS 'Type of billing: one_off, monthly, quarterly, or renewal';
COMMENT ON COLUMN revenue_events.payment_stage IS 'Stage of payment: invoice (initial), completion (50/50 second payment), or renewal';
COMMENT ON COLUMN revenue_events.commissionable IS 'Whether this revenue event generates commission (can be false for non-commissionable revenue)';

COMMENT ON COLUMN commission_entries.revenue_event_id IS 'Link to the revenue event that generated this commission entry';
COMMENT ON COLUMN commission_entries.accrual_date IS 'Date when commission was earned (same as revenue collection date)';
COMMENT ON COLUMN commission_entries.payable_date IS 'Date when commission becomes payable (accrual_date + payout_delay_days)';
COMMENT ON COLUMN commission_entries.month IS 'DEPRECATED: Use accrual_date instead. Kept for backward compatibility.';

COMMENT ON COLUMN commission_rules.payout_delay_days IS 'Number of days after revenue collection before commission becomes payable (default: 30)';

COMMENT ON COLUMN bdr_reps.allow_trailing_commission IS 'If true, BDR continues to earn commission on revenue events after leave_date';
COMMENT ON COLUMN bdr_reps.leave_date IS 'Date when BDR left the company. Used to determine if trailing commission is allowed.';

