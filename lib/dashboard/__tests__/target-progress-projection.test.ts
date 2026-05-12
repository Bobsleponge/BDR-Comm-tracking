import { describe, expect, it } from 'vitest';
import { buildTargetProgressProjection } from '@/lib/dashboard/target-progress-projection';

describe('target-progress-projection', () => {
  it('adds scheduled revenue to actual and computes projected percent', () => {
    const projection = buildTargetProgressProjection(120000, 80000, 250000);
    expect(projection.projectedRevenueCollected).toBe(200000);
    expect(projection.projectedAchievedPercent).toBe(80);
  });
});
