/**
 * Approval lock logic: prevents double-billing after deal edits shift payable dates.
 *
 * Each approved fingerprint (deal + month + amount) can settle at most one live entry.
 * - Exact match: entry month + amount matches a fingerprint
 * - Shifted match: amount matches a fingerprint whose month has no live entry at that amount
 * - Quota exhausted: all fingerprints for an amount are already assigned — duplicates blocked
 */

import { getEntryEffectiveMonth, normDateStr } from '@/lib/commission/entry-month';

export const AMOUNT_MATCH_TOLERANCE = 0.02;

export function amountsMatch(a: number, b: number, tolerance = AMOUNT_MATCH_TOLERANCE): boolean {
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

export function amountKey(amount: number): string {
  return Number(amount).toFixed(2);
}

export interface RawFingerprint {
  bdr_id: string;
  deal_id: string;
  effective_date: string;
  amount: number;
  batch_id: string;
  batch_status?: string;
}

export interface DedupedApprovalLock {
  bdrId: string;
  dealId: string;
  amount: number;
  effectiveDate: string;
  month: string;
  batchId: string;
  batchStatus: 'approved' | 'paid' | 'unknown';
}

export interface DealApprovalLocks {
  dealId: string;
  locks: DedupedApprovalLock[];
}

export function dedupeFingerprints(rows: RawFingerprint[]): DedupedApprovalLock[] {
  const seen = new Set<string>();
  const result: DedupedApprovalLock[] = [];

  for (const row of rows) {
    const eff = normDateStr(row.effective_date) ?? row.effective_date;
    const key = `${row.deal_id}|${amountKey(row.amount)}|${eff}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const month = getEntryEffectiveMonth(eff) ?? eff.slice(0, 7);
    const status =
      row.batch_status === 'paid' || row.batch_status === 'approved'
        ? row.batch_status
        : 'unknown';

    result.push({
      bdrId: row.bdr_id,
      dealId: row.deal_id,
      amount: Number(row.amount),
      effectiveDate: eff,
      month,
      batchId: row.batch_id,
      batchStatus: status,
    });
  }

  return result.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

export function buildDealApprovalLocks(
  dealId: string,
  allLocks: DedupedApprovalLock[]
): DealApprovalLocks {
  return {
    dealId,
    locks: allLocks.filter((l) => l.dealId === dealId),
  };
}

export interface CommissionEntryLike {
  id?: string;
  bdr_id: string;
  deal_id: string;
  amount: number;
  payable_date?: string | null;
  accrual_date?: string | null;
  month?: string | null;
  status?: string | null;
}

function entryMonth(entry: CommissionEntryLike): string | null {
  return getEntryEffectiveMonth(entry.payable_date, entry.accrual_date, entry.month);
}

function fingerprintSlotKey(lock: DedupedApprovalLock): string {
  return `${lock.month}|${amountKey(lock.amount)}`;
}

function compareEntries(a: CommissionEntryLike, b: CommissionEntryLike): number {
  const da = entryMonth(a) ?? '';
  const db = entryMonth(b) ?? '';
  return da.localeCompare(db) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

type EntryWithKey = { entry: CommissionEntryLike; key: string };

function entriesWithStableKeys(peerEntries: CommissionEntryLike[]): EntryWithKey[] {
  return peerEntries.map((entry, i) => ({
    entry,
    key: entry.id ?? `__idx_${i}`,
  }));
}

/**
 * Assign each fingerprint slot to at most one entry (exact match preferred, then shifted).
 */
export function assignFingerprintsToEntries(
  dealLocks: DealApprovalLocks,
  peerEntries: CommissionEntryLike[]
): Map<string, DedupedApprovalLock> {
  const assignments = new Map<string, DedupedApprovalLock>();
  const usedSlots = new Set<string>();
  const sorted = [...entriesWithStableKeys(peerEntries)].sort((a, b) =>
    compareEntries(a.entry, b.entry)
  );

  // Phase 1: exact month + amount
  for (const { entry, key } of sorted) {
    const month = entryMonth(entry);
    if (!month) continue;
    for (const lock of dealLocks.locks) {
      const slot = fingerprintSlotKey(lock);
      if (usedSlots.has(slot)) continue;
      if (lock.month === month && amountsMatch(lock.amount, entry.amount)) {
        assignments.set(key, lock);
        usedSlots.add(slot);
        break;
      }
    }
  }

  // Phase 2: shifted — fingerprint month has no live entry at that amount
  for (const { entry, key } of sorted) {
    if (assignments.has(key)) continue;
    const month = entryMonth(entry);
    if (!month) continue;
    for (const lock of dealLocks.locks) {
      const slot = fingerprintSlotKey(lock);
      if (usedSlots.has(slot)) continue;
      if (lock.month === month) continue;
      if (!amountsMatch(lock.amount, entry.amount)) continue;

      const fpMonthOccupied = peerEntries.some(
        (p) => entryMonth(p) === lock.month && amountsMatch(p.amount, lock.amount)
      );
      if (fpMonthOccupied) continue;

      assignments.set(key, lock);
      usedSlots.add(slot);
      break;
    }
  }

  return assignments;
}

function resolveEntryKey(
  entry: CommissionEntryLike,
  peerEntries: CommissionEntryLike[]
): string {
  if (entry.id) return entry.id;
  const idx = peerEntries.indexOf(entry);
  return idx >= 0 ? `__idx_${idx}` : '__hypothetical__';
}

function isAmountQuotaExhausted(
  entry: CommissionEntryLike,
  dealLocks: DealApprovalLocks,
  assignments: Map<string, DedupedApprovalLock>,
  peerEntries: CommissionEntryLike[],
  entryKey: string
): boolean {
  const locksForAmount = dealLocks.locks.filter((l) => amountsMatch(l.amount, entry.amount));
  const slotCount = new Set(locksForAmount.map(fingerprintSlotKey)).size;
  if (slotCount === 0) return false;

  const month = entryMonth(entry);
  if (!month || assignments.has(entryKey)) return false;

  const maxFpMonth = locksForAmount.map((l) => l.month).sort().pop()!;
  // Months after the last approved fingerprint are new claimable periods (MRR, 2nd deposit, etc.)
  if (month > maxFpMonth) return false;

  if (locksForAmount.some((l) => l.month === month)) return false;

  const assignedForAmount = [...assignments.values()].filter((l) =>
    amountsMatch(l.amount, entry.amount)
  ).length;

  return assignedForAmount >= slotCount;
}

/** Fingerprint row that settles this entry, if any. */
export function matchEntryToFingerprint(
  entry: CommissionEntryLike,
  dealLocks: DealApprovalLocks,
  peerEntries: CommissionEntryLike[]
): DedupedApprovalLock | null {
  const assignments = assignFingerprintsToEntries(dealLocks, peerEntries);
  const key = resolveEntryKey(entry, peerEntries);
  return assignments.get(key) ?? null;
}

/**
 * Whether this entry is settled (approved or paid) and must not appear on a new report.
 */
export function isEntryApprovalSettled(
  entry: CommissionEntryLike,
  dealLocks: DealApprovalLocks,
  peerEntries: CommissionEntryLike[]
): boolean {
  if (entry.status === 'paid') return true;
  if (entry.status === 'cancelled') return false;

  const assignments = assignFingerprintsToEntries(dealLocks, peerEntries);
  const key = resolveEntryKey(entry, peerEntries);

  if (assignments.has(key)) return true;

  return isAmountQuotaExhausted(entry, dealLocks, assignments, peerEntries, key);
}

/**
 * Whether a new commission entry should be skipped during reprocess.
 */
export function shouldSkipCommissionCreation(
  dealId: string,
  amount: number,
  payableDate: string,
  accrualDate: string,
  dealLocks: DealApprovalLocks,
  existingEntries: CommissionEntryLike[]
): boolean {
  const hypothetical: CommissionEntryLike = {
    bdr_id: existingEntries[0]?.bdr_id ?? '',
    deal_id: dealId,
    amount,
    payable_date: payableDate,
    accrual_date: accrualDate,
    month: accrualDate,
    status: 'accrued',
  };

  return isEntryApprovalSettled(hypothetical, dealLocks, [...existingEntries, hypothetical]);
}

export function isEntryBillable(
  entry: CommissionEntryLike,
  dealLocks: DealApprovalLocks,
  allEntriesForDeal: CommissionEntryLike[]
): boolean {
  if (entry.status === 'cancelled' || entry.status === 'ignored') return false;
  return !isEntryApprovalSettled(entry, dealLocks, allEntriesForDeal);
}

/** Batch status for the fingerprint that settles this entry. */
export function settlementBatchStatus(
  entry: CommissionEntryLike,
  dealLocks: DealApprovalLocks,
  peerEntries: CommissionEntryLike[]
): 'paid' | 'approved' | null {
  const match = matchEntryToFingerprint(entry, dealLocks, peerEntries);
  if (!match) return null;
  if (match.batchStatus === 'paid') return 'paid';
  if (match.batchStatus === 'approved') return 'approved';
  return 'approved';
}
