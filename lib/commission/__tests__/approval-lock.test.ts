import { describe, it, expect } from 'vitest';
import {
  buildDealApprovalLocks,
  dedupeFingerprints,
  isEntryApprovalSettled,
  isEntryBillable,
  shouldSkipCommissionCreation,
} from '../approval-lock';

describe('approval-lock', () => {
  const fingerprints = dedupeFingerprints([
    { bdr_id: 'b1', deal_id: 'd1', effective_date: '2026-01-06', amount: 156.25, batch_id: 'batch1', batch_status: 'paid' },
    { bdr_id: 'b1', deal_id: 'd1', effective_date: '2026-01-06', amount: 156.25, batch_id: 'batch1', batch_status: 'paid' },
    { bdr_id: 'b1', deal_id: 'd2', effective_date: '2026-01-07', amount: 75, batch_id: 'batch1', batch_status: 'paid' },
    { bdr_id: 'b1', deal_id: 'd2', effective_date: '2026-03-07', amount: 75, batch_id: 'batch2', batch_status: 'approved' },
  ]);

  it('dedupes identical fingerprints', () => {
    expect(fingerprints).toHaveLength(3);
  });

  it('blocks shifted payable date when amount matches orphaned fingerprint', () => {
    const locks = buildDealApprovalLocks('d1', fingerprints);
    const marEntry = {
      id: 'e2',
      bdr_id: 'b1',
      deal_id: 'd1',
      amount: 156.25,
      payable_date: '2026-03-30',
      status: 'accrued',
    };
    expect(isEntryApprovalSettled(marEntry, locks, [marEntry])).toBe(true);
    expect(
      shouldSkipCommissionCreation('d1', 156.25, '2026-03-30', '2026-03-23', locks, [])
    ).toBe(true);
  });

  it('treats ignored entries as not billable', () => {
    const locks = buildDealApprovalLocks('d1', fingerprints);
    const ignored = {
      id: 'e-ignored',
      bdr_id: 'b1',
      deal_id: 'd1',
      amount: 12.5,
      payable_date: '2026-02-15',
      status: 'ignored',
    };
    expect(isEntryBillable(ignored, locks, [ignored])).toBe(false);
  });

  it('allows second payment in a later month when only first month is fingerprinted', () => {
    const locks = buildDealApprovalLocks('d1', fingerprints);
    const janPaid = {
      id: 'e1',
      bdr_id: 'b1',
      deal_id: 'd1',
      amount: 156.25,
      payable_date: '2026-01-06',
      status: 'paid',
    };
    const marSecond = {
      id: 'e2',
      bdr_id: 'b1',
      deal_id: 'd1',
      amount: 156.25,
      payable_date: '2026-03-30',
      status: 'accrued',
    };
    expect(isEntryApprovalSettled(marSecond, locks, [janPaid, marSecond])).toBe(false);
    expect(isEntryBillable(marSecond, locks, [janPaid, marSecond])).toBe(true);
  });

  it('does not settle a different amount in the same month', () => {
    const locks = buildDealApprovalLocks('d2', fingerprints);
    const janSmall = {
      id: 'e3',
      bdr_id: 'b1',
      deal_id: 'd2',
      amount: 37.5,
      payable_date: '2026-01-07',
      status: 'accrued',
    };
    const janBig = {
      id: 'e4',
      bdr_id: 'b1',
      deal_id: 'd2',
      amount: 75,
      payable_date: '2026-01-07',
      status: 'paid',
    };
    expect(isEntryApprovalSettled(janSmall, locks, [janSmall, janBig])).toBe(false);
    expect(isEntryApprovalSettled(janBig, locks, [janSmall, janBig])).toBe(true);
  });

  it('matches exact month and amount', () => {
    const locks = buildDealApprovalLocks('d2', fingerprints);
    const mar = {
      id: 'e5',
      bdr_id: 'b1',
      deal_id: 'd2',
      amount: 75,
      payable_date: '2026-03-07',
      status: 'accrued',
    };
    expect(isEntryApprovalSettled(mar, locks, [mar])).toBe(true);
  });

  it('allows MRR months beyond the last approved fingerprint', () => {
    const locks = buildDealApprovalLocks('d2', fingerprints);
    const janPaid = {
      id: 'e6',
      bdr_id: 'b1',
      deal_id: 'd2',
      amount: 75,
      payable_date: '2026-01-07',
      status: 'paid',
    };
    const marApproved = {
      id: 'e7',
      bdr_id: 'b1',
      deal_id: 'd2',
      amount: 75,
      payable_date: '2026-03-07',
      status: 'accrued',
    };
    const mayNew = {
      id: 'e8',
      bdr_id: 'b1',
      deal_id: 'd2',
      amount: 75,
      payable_date: '2026-05-07',
      status: 'accrued',
    };
    const peers = [janPaid, marApproved, mayNew];
    expect(isEntryApprovalSettled(mayNew, locks, peers)).toBe(false);
    expect(isEntryBillable(mayNew, locks, peers)).toBe(true);
  });
});
