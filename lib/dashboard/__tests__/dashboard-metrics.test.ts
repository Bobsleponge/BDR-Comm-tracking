import { describe, expect, it } from 'vitest';
import {
  computeCommissionBucketsFromEntries,
  resolveBatchLineAmount,
} from '@/lib/dashboard/dashboard-metrics';
import type { LocalApprovalSets } from '@/lib/commission/entry-approval-display';

const emptySets: LocalApprovalSets = {
  approvedEntryIds: new Set(),
  fpSet: new Set(),
  fpMonthSet: new Set(),
};

describe('dashboard-metrics', () => {
  describe('resolveBatchLineAmount', () => {
    it('prefers override amount when present', () => {
      expect(
        resolveBatchLineAmount({
          override_amount: 120,
          override_commission_rate: 0.1,
          entry_amount: 80,
          amount_collected: 1000,
        })
      ).toBe(120);
    });

    it('uses override rate against collected revenue when amount override is absent', () => {
      expect(
        resolveBatchLineAmount({
          override_amount: null,
          override_commission_rate: 0.1,
          entry_amount: 80,
          amount_collected: 1000,
        })
      ).toBe(100);
    });

    it('falls back to entry amount', () => {
      expect(
        resolveBatchLineAmount({
          override_amount: null,
          override_commission_rate: null,
          entry_amount: 80,
          amount_collected: 1000,
        })
      ).toBe(80);
    });
  });

  describe('computeCommissionBucketsFromEntries', () => {
    it('counts settled and open lines using approval display rules', () => {
      const approvalSets: LocalApprovalSets = {
        approvedEntryIds: new Set(['approved-entry']),
        fpSet: new Set(),
        fpMonthSet: new Set(),
      };
      const batchAmountByEntryId = new Map<string, number>([['approved-entry', 150]]);

      const buckets = computeCommissionBucketsFromEntries(
        [
          {
            id: 'approved-entry',
            bdr_id: 'rep-1',
            deal_id: 'deal-1',
            amount: 100,
            status: 'payable',
            payable_date: '2026-05-01',
          },
          {
            id: 'open-entry',
            bdr_id: 'rep-1',
            deal_id: 'deal-2',
            amount: 40,
            status: 'accrued',
            accrual_date: '2026-05-10',
          },
          {
            id: 'paid-entry',
            bdr_id: 'rep-1',
            deal_id: 'deal-3',
            amount: 25,
            status: 'paid',
          },
        ],
        approvalSets,
        batchAmountByEntryId,
        '2026-06-01',
        '2026-05-01',
        '2026-06-01'
      );

      expect(buckets.settled).toBe(175);
      expect(buckets.pending).toBe(40);
      expect(buckets.accrued).toBe(40);
      expect(buckets.accruedThisMonth).toBe(40);
    });

    it('returns zero buckets when there are no entries', () => {
      const buckets = computeCommissionBucketsFromEntries(
        [],
        emptySets,
        new Map(),
        '2026-06-01',
        '2026-05-01',
        '2026-06-01'
      );

      expect(buckets).toEqual({
        settled: 0,
        pending: 0,
        payable: 0,
        accrued: 0,
        accruedThisMonth: 0,
      });
    });
  });
});
