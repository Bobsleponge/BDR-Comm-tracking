-- Store the payable-through date chosen when generating a commission report batch
ALTER TABLE commission_batches
ADD COLUMN IF NOT EXISTS payable_cutoff DATE;

COMMENT ON COLUMN commission_batches.payable_cutoff IS 'Include only commission entries with payable date on or before this date (report period end).';
