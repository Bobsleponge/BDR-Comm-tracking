-- Migration: Commission Batch System (Manual Commission Pull)
-- Adds invoiced_batch_id to commission_entries and creates commission_batches,
-- commission_batch_items for BDR-controlled report generation

-- Create commission_batches table first (no FK to commission_entries)
CREATE TABLE IF NOT EXISTS commission_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bdr_id UUID NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
  run_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commission_batches_bdr_id ON commission_batches(bdr_id);
CREATE INDEX IF NOT EXISTS idx_commission_batches_status ON commission_batches(status);
CREATE INDEX IF NOT EXISTS idx_commission_batches_bdr_status ON commission_batches(bdr_id, status);

-- Create commission_batch_items table
CREATE TABLE IF NOT EXISTS commission_batch_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id UUID NOT NULL REFERENCES commission_batches(id) ON DELETE CASCADE,
  commission_entry_id UUID NOT NULL REFERENCES commission_entries(id) ON DELETE CASCADE,
  override_amount DECIMAL(12,2),
  adjustment_note TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(batch_id, commission_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_commission_batch_items_batch_id ON commission_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_commission_batch_items_entry_id ON commission_batch_items(commission_entry_id);

-- Add invoiced_batch_id to commission_entries
ALTER TABLE commission_entries
ADD COLUMN IF NOT EXISTS invoiced_batch_id UUID REFERENCES commission_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_commission_entries_invoiced_batch_id ON commission_entries(invoiced_batch_id);

-- Trigger for updated_at on commission_batches
CREATE TRIGGER update_commission_batches_updated_at
  BEFORE UPDATE ON commission_batches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger for updated_at on commission_batch_items
CREATE TRIGGER update_commission_batch_items_updated_at
  BEFORE UPDATE ON commission_batch_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE commission_batches IS 'BDR commission report batches. draft = editable, approved = locked for billing.';
COMMENT ON COLUMN commission_entries.invoiced_batch_id IS 'NULL = not yet invoiced. Populated = included in a batch (billed or draft).';
