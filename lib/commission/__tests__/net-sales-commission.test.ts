import { describe, expect, it } from 'vitest';
import {
  computeNetSalesCommissionAmount,
  getEffectiveBillingPercentageForCommission,
} from '../net-sales-commission';

describe('net-sales-commission', () => {
  it('uses full billing % for new pct-of-net-sales', () => {
    expect(getEffectiveBillingPercentageForCommission(0.0125, { isRenewal: false })).toBe(0.0125);
    expect(computeNetSalesCommissionAmount(100_000, 0.0125, 0.025)).toBe(31.25);
  });

  it('uses billing uplift for renewal pct-of-net-sales (option B)', () => {
    expect(
      getEffectiveBillingPercentageForCommission(0.0125, {
        isRenewal: true,
        originalBillingPercentage: 0.01,
      })
    ).toBe(0.0025);
    expect(
      computeNetSalesCommissionAmount(100_000, 0.0125, 0.025, {
        isRenewal: true,
        originalBillingPercentage: 0.01,
      })
    ).toBe(6.25);
  });

  it('returns null when renewal has no uplift', () => {
    expect(
      computeNetSalesCommissionAmount(100_000, 0.01, 0.025, {
        isRenewal: true,
        originalBillingPercentage: 0.01,
      })
    ).toBeNull();
  });
});
