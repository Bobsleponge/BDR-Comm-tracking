import { describe, it, expect } from 'vitest';
import {
  collectPayableMonths,
  getPayableMonthFromEntry,
  groupEntriesByPayableMonth,
} from '../payable-months';

describe('payable-months', () => {
  it('resolves payable month from payable_date', () => {
    expect(getPayableMonthFromEntry({ payable_date: '2027-08-15' })).toBe('2027-08');
  });

  it('collects and sorts unique months including far future', () => {
    const months = collectPayableMonths([
      { payable_date: '2027-08-01' },
      { payable_date: '2026-03-10' },
      { payable_date: '2027-08-20' },
      { accrual_date: '2025-12-05' },
    ]);
    expect(months).toEqual(['2025-12', '2026-03', '2027-08']);
  });

  it('groups entries into month buckets with totals', () => {
    const buckets = groupEntriesByPayableMonth(
      [
        { payable_date: '2027-08-01', amount: 10 },
        { payable_date: '2027-08-15', amount: 5 },
        { payable_date: '2026-01-01', amount: 3 },
      ] as Array<{ payable_date: string; amount: number }>,
      (e) => e.amount
    );
    expect(buckets.map((b) => b.month)).toEqual(['2026-01', '2027-08']);
    expect(buckets[1].totalAmount).toBe(15);
    expect(buckets[1].entries).toHaveLength(2);
  });
});
