-- Approved commission fingerprints: survives reprocessing
-- When commission_entries are deleted (reprocess), commission_batch_items CASCADE delete.
-- This table stores (bdr_id, deal_id, effective_date, amount) so we can exclude
-- "logical duplicates" when determining eligibility even after reprocessing.

CREATE TABLE IF NOT EXISTS approved_commission_fingerprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bdr_id UUID NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  effective_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  batch_id UUID NOT NULL REFERENCES commission_batches(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_acf_bdr_deal_date ON approved_commission_fingerprints(bdr_id, deal_id, effective_date);

COMMENT ON TABLE approved_commission_fingerprints IS 'Stores approved commission fingerprints to exclude logical duplicates after reprocessing (batch_items CASCADE when entries deleted)';

-- Backfill from existing approved/paid batches (batches where items were CASCADE-deleted have no data)
INSERT INTO approved_commission_fingerprints (id, bdr_id, deal_id, effective_date, amount, batch_id)
SELECT gen_random_uuid(), ce.bdr_id, ce.deal_id,
  COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01'),
  COALESCE(cbi.override_amount, ce.amount),
  cb.id
FROM commission_batch_items cbi
JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
JOIN commission_batches cb ON cbi.batch_id = cb.id
WHERE cb.status IN ('approved', 'paid')
  AND COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01') IS NOT NULL
  AND COALESCE(cbi.override_amount, ce.amount) IS NOT NULL;
