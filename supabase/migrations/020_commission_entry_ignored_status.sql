-- Allow BDRs to permanently waive a specific commission entry (distinct from cancelled deal entries)
ALTER TABLE commission_entries
DROP CONSTRAINT IF EXISTS commission_entries_status_check;

ALTER TABLE commission_entries
ADD CONSTRAINT commission_entries_status_check
CHECK (status IN ('accrued', 'pending', 'payable', 'paid', 'cancelled', 'ignored'));

COMMENT ON COLUMN commission_entries.status IS 'ignored = BDR waived this specific payment; excluded from all future reports but does not block future deal commissions';
