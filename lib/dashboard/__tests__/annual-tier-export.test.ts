import { describe, expect, it } from 'vitest';
import { buildAnnualTierProgress, normalizeAnnualTierRules } from '@/lib/dashboard/annual-tier-export';

describe('annual-tier-export', () => {
  it('splits collections across tiers in date order', () => {
    const progress = buildAnnualTierProgress(
      [
        {
          id: '1',
          collection_date: '2026-01-15',
          amount_collected: 240000,
          billing_type: 'one_off',
          client_name: 'Alpha',
          deal: 'Service A',
        },
        {
          id: '2',
          collection_date: '2026-02-01',
          amount_collected: 20000,
          billing_type: 'one_off',
          client_name: 'Beta',
          deal: 'Service B',
        },
      ],
      normalizeAnnualTierRules({
        tier_1_threshold: 250000,
        tier_1_rate: 0.025,
        tier_2_rate: 0.05,
      }),
      2026
    );

    expect(progress.summary.revenueCollected).toBe(260000);
    expect(progress.summary.revenueInTier1).toBe(250000);
    expect(progress.summary.revenueInTier2).toBe(10000);
    expect(progress.summary.tier1Commission).toBe(6250);
    expect(progress.summary.tier2Commission).toBe(500);
    expect(progress.summary.totalTierCommission).toBe(6750);
    expect(progress.rows[1].tier_1_revenue).toBe('10000.00');
    expect(progress.rows[1].tier_2_revenue).toBe('10000.00');
  });
});
