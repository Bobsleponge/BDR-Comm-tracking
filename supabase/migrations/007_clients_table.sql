-- Create clients table
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add client_id to deals table
ALTER TABLE deals
ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;

-- Create index for client_id
CREATE INDEX IF NOT EXISTS idx_deals_client_id ON deals(client_id);

-- Create index for client name searches
CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);

-- Create trigger for updated_at timestamp
CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Migrate existing client_name data to clients table (if any)
-- This creates clients from existing deals and links them
INSERT INTO clients (name, created_at, updated_at)
SELECT DISTINCT client_name, MIN(created_at), MAX(updated_at)
FROM deals
WHERE client_name IS NOT NULL AND client_name != ''
  AND NOT EXISTS (
    SELECT 1 FROM clients WHERE clients.name = deals.client_name
  )
GROUP BY client_name
ON CONFLICT DO NOTHING;

-- Link existing deals to clients
UPDATE deals d
SET client_id = c.id
FROM clients c
WHERE d.client_name = c.name
  AND d.client_id IS NULL;



