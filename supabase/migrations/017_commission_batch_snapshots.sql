-- Commission batch snapshots: immutable copy at approve time
-- Survives reprocessing (commission_batch_items CASCADE when entries deleted)

CREATE TABLE IF NOT EXISTS commission_batch_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL UNIQUE REFERENCES commission_batches(id) ON DELETE CASCADE,
  snapshot_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commission_batch_snapshots_batch_id ON commission_batch_snapshots(batch_id);

COMMENT ON TABLE commission_batch_snapshots IS 'Frozen report rows at approve time; display and export use this for approved/paid batches';
