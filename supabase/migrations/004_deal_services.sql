-- Create deal_services table
CREATE TABLE IF NOT EXISTS deal_services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL,
  billing_type TEXT NOT NULL CHECK (billing_type IN ('one_off', 'mrr', 'deposit')),
  unit_price DECIMAL(12,2) NOT NULL,
  monthly_price DECIMAL(12,2), -- nullable, required for MRR
  quantity INTEGER NOT NULL DEFAULT 1,
  contract_months INTEGER NOT NULL DEFAULT 12, -- for MRR
  commission_rate DECIMAL(5,4), -- nullable, overrides global rate
  commissionable_value DECIMAL(12,2) NOT NULL, -- calculated
  commission_amount DECIMAL(12,2) NOT NULL, -- calculated
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type);

-- Create trigger for updated_at timestamp
CREATE TRIGGER update_deal_services_updated_at BEFORE UPDATE ON deal_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();





