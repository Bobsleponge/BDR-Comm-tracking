import { describe, expect, it } from 'vitest';
import { buildAnnualTierProgress, normalizeAnnualTierRules } from '@/lib/dashboard/annual-tier-export';

const rules = normalizeAnnualTierRules({
  tier_1_threshold: 250000,
  tier_1_rate: 0.025,
  tier_2_rate: 0.05,
});

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
      rules,
      2026
    );

    expect(progress.summary.revenueCollected).toBe(260000);
    expect(progress.summary.revenueInTier1).toBe(250000);
    expect(progress.summary.revenueInTier2).toBe(10000);
    expect(progress.summary.tier1Commission).toBe(6250);
    expect(progress.summary.tier2Commission).toBe(500);
    expect(progress.summary.totalTierCommission).toBe(6750);
    expect(progress.summary.tier2ExtraCommission).toBe(250);
    expect(progress.rows[1].tier_1_revenue).toBe('10000.00');
    expect(progress.rows[1].tier_2_revenue).toBe('10000.00');
  });

  it('projects tier splits when scheduled collections cross the threshold', () => {
    const actualRows = [
      {
        id: '1',
        collection_date: '2026-01-15',
        amount_collected: 240000,
        billing_type: 'one_off',
        client_name: 'Alpha',
        deal: 'Service A',
      },
    ];
    const scheduledRows = [
      {
        id: '2',
        collection_date: '2026-06-01',
        amount_collected: 30000,
        billing_type: 'one_off',
        client_name: 'Beta',
        deal: 'Service B',
      },
    ];

    const actual = buildAnnualTierProgress(actualRows, rules, 2026);
    const projected = buildAnnualTierProgress([...actualRows, ...scheduledRows], rules, 2026);

    expect(actual.summary.revenueCollected).toBe(240000);
    expect(actual.summary.revenueInTier2).toBe(0);
    expect(actual.summary.tier2ExtraCommission).toBe(0);

    expect(projected.summary.revenueCollected).toBe(270000);
    expect(projected.summary.revenueInTier1).toBe(250000);
    expect(projected.summary.revenueInTier2).toBe(20000);
    expect(projected.summary.tier1Commission).toBe(6250);
    expect(projected.summary.tier2Commission).toBe(1000);
    expect(projected.summary.tier2ExtraCommission).toBe(500);
    expect(projected.summary.projectedTotalTierCommission).toBe(7250);
  });
});
