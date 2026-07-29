import { describe, it, expect } from 'vitest';
import {
  batchItemEffectiveDate,
  effectivePayableDate,
  filterBatchItemsWithinCutoff,
  isWithinPayableCutoff,
  resolveBatchPayableCutoff,
} from '../batch-payable-cutoff';

describe('batch-payable-cutoff', () => {
  it('resolves stored cutoff over run_date', () => {
    expect(resolveBatchPayableCutoff({ payable_cutoff: '2026-05-31', run_date: '2026-06-08' })).toBe(
      '2026-05-31'
    );
  });

  it('excludes items payable after cutoff', () => {
    const items = [
      {
        commission_entry_id: 'a',
        override_payment_date: '2026-05-30',
        payable_date: null,
      },
      {
        commission_entry_id: 'b',
        override_payment_date: '2026-06-01',
        payable_date: null,
      },
    ];
    const kept = filterBatchItemsWithinCutoff(items, '2026-05-31');
    expect(kept.map((i) => i.commission_entry_id)).toEqual(['a']);
  });

  it('uses override payment date for effective payable date', () => {
    expect(
      batchItemEffectiveDate({
        commission_entry_id: 'x',
        override_payment_date: '2026-06-01',
        payable_date: '2026-05-15',
      })
    ).toBe('2026-06-01');
    expect(isWithinPayableCutoff(effectivePayableDate('2026-06-01', '2026-05-15', null, null), '2026-05-31')).toBe(
      false
    );
  });
});
