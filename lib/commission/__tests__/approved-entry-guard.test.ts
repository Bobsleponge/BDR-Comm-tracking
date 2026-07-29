import { describe, it, expect } from 'vitest';
import { getEntryEffectiveMonth } from '../entry-month';

describe('getEntryEffectiveMonth', () => {
  it('uses payable_date first', () => {
    expect(getEntryEffectiveMonth('2025-03-15', '2025-02-01', '2025-01')).toBe('2025-03');
  });

  it('falls back to accrual_date', () => {
    expect(getEntryEffectiveMonth(null, '2025-04-20', null)).toBe('2025-04');
  });

  it('falls back to month field', () => {
    expect(getEntryEffectiveMonth(null, null, '2025-05')).toBe('2025-05');
  });
});
