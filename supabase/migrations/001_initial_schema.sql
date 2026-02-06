-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create bdr_reps table
CREATE TABLE IF NOT EXISTS bdr_reps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create commission_rules table
CREATE TABLE IF NOT EXISTS commission_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  base_rate DECIMAL(5,4) NOT NULL DEFAULT 0.025,
  quarterly_bonus_rate DECIMAL(5,4) NOT NULL DEFAULT 0.025,
  renewal_rate DECIMAL(5,4) NOT NULL DEFAULT 0.01,
  payout_months_default INTEGER NOT NULL DEFAULT 12,
  tier_1_threshold DECIMAL(12,2),
  tier_1_rate DECIMAL(5,4),
  tier_2_rate DECIMAL(5,4),
  quarterly_target DECIMAL(12,2),
  clawback_days INTEGER,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

-- Create service_pricing table
CREATE TABLE IF NOT EXISTS service_pricing (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_type TEXT NOT NULL UNIQUE,
  commission_percent DECIMAL(5,4),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create deals table
CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bdr_id UUID NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  service_type TEXT NOT NULL,
  proposal_date DATE NOT NULL,
  close_date DATE,
  first_invoice_date DATE,
  deal_value DECIMAL(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'closed-won', 'closed-lost')),
  is_renewal BOOLEAN NOT NULL DEFAULT false,
  original_deal_id UUID REFERENCES deals(id),
  cancellation_date DATE,
  payout_months INTEGER NOT NULL DEFAULT 12,
  do_not_pay_future BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create commission_entries table
CREATE TABLE IF NOT EXISTS commission_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  bdr_id UUID NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(deal_id, month)
);

-- Create quarterly_targets table
CREATE TABLE IF NOT EXISTS quarterly_targets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bdr_id UUID NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
  quarter TEXT NOT NULL,
  target_revenue DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(bdr_id, quarter)
);

-- Create quarterly_performance table
CREATE TABLE IF NOT EXISTS quarterly_performance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bdr_id UUID NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
  quarter TEXT NOT NULL,
  revenue_collected DECIMAL(12,2) NOT NULL DEFAULT 0,
  achieved_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  bonus_eligible BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(bdr_id, quarter)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_deals_bdr_id ON deals(bdr_id);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS idx_commission_entries_bdr_id ON commission_entries(bdr_id);
CREATE INDEX IF NOT EXISTS idx_commission_entries_deal_id ON commission_entries(deal_id);
CREATE INDEX IF NOT EXISTS idx_commission_entries_month ON commission_entries(month);
CREATE INDEX IF NOT EXISTS idx_commission_entries_status ON commission_entries(status);
CREATE INDEX IF NOT EXISTS idx_quarterly_targets_bdr_id ON quarterly_targets(bdr_id);
CREATE INDEX IF NOT EXISTS idx_quarterly_performance_bdr_id ON quarterly_performance(bdr_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_bdr_reps_updated_at BEFORE UPDATE ON bdr_reps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_deals_updated_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_commission_entries_updated_at BEFORE UPDATE ON commission_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_commission_rules_updated_at BEFORE UPDATE ON commission_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_quarterly_targets_updated_at BEFORE UPDATE ON quarterly_targets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_quarterly_performance_updated_at BEFORE UPDATE ON quarterly_performance
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_service_pricing_updated_at BEFORE UPDATE ON service_pricing
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default commission rules
INSERT INTO commission_rules (base_rate, quarterly_bonus_rate, renewal_rate, payout_months_default, tier_1_threshold, tier_1_rate, tier_2_rate, quarterly_target, clawback_days)
VALUES (0.025, 0.025, 0.01, 12, 250000.00, 0.025, 0.05, 75000.00, 90)
ON CONFLICT DO NOTHING;



