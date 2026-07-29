/**
 * Single place for "is this commission line approved for UI display?" (local SQLite).
 * Only marks approved when actually paid, in an approved batch, or exact month+amount fingerprint match.
 * (Billable filtering uses separate lock logic — do not conflate "blocked duplicate" with "approved".)
 */
import {
  assignFingerprintsToEntries,
  buildDealApprovalLocks,
  dedupeFingerprints,
  type CommissionEntryLike,
  type DedupedApprovalLock,
  type RawFingerprint,
} from '@/lib/commission/approval-lock';
import { getEntryEffectiveMonth, normDateStr } from '@/lib/commission/entry-month';
import { getLocalDB } from '@/lib/db/local-db';

type LocalDb = ReturnType<typeof getLocalDB>;

export { normDateStr };

export type EntryApprovalSource =
  | { kind: 'paid' }
  | { kind: 'batch'; reportDate: string }
  | { kind: 'fingerprint'; reportDate: string; approvedMonth: string; shifted: boolean };

export type LocalApprovalContext = {
  approvedEntryIds: Set<string>;
  batchRunDateByEntryId: Map<string, string>;
  batchRunDateByBatchId: Map<string, string>;
  dealsMap: Map<string, ReturnType<typeof buildDealApprovalLocks>>;
  entriesByDeal: Map<string, CommissionEntryLike[]>;
};

export function getLocalApprovalContext(db: LocalDb): LocalApprovalContext {
  const approvedRows = db
    .prepare(
      `
    SELECT cbi.commission_entry_id AS id, cb.run_date, cb.id AS batch_id
    FROM commission_batch_items cbi
    INNER JOIN commission_batches cb ON cbi.batch_id = cb.id
    WHERE cb.status IN ('approved', 'paid')
  `
    )
    .all() as { id: string; run_date: string; batch_id: string }[];
  const approvedEntryIds = new Set(approvedRows.map((r) => r.id));
  const batchRunDateByEntryId = new Map<string, string>();
  for (const row of approvedRows) {
    batchRunDateByEntryId.set(row.id, row.run_date);
  }

  const batchRunDateByBatchId = new Map<string, string>(
    (
      db
        .prepare(`SELECT id, run_date FROM commission_batches WHERE status IN ('approved', 'paid')`)
        .all() as { id: string; run_date: string }[]
    ).map((b) => [b.id, b.run_date])
  );

  const fingerprintRows = db
    .prepare(
      `
    SELECT acf.bdr_id, acf.deal_id, acf.effective_date, acf.amount, acf.batch_id, cb.status as batch_status
    FROM approved_commission_fingerprints acf
    LEFT JOIN commission_batches cb ON cb.id = acf.batch_id
  `
    )
    .all() as RawFingerprint[];

  const allEntries = db
    .prepare(
      `
    SELECT id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status
    FROM commission_entries
  `
    )
    .all() as CommissionEntryLike[];

  const deduped = dedupeFingerprints(fingerprintRows);
  const entriesByDeal = new Map<string, CommissionEntryLike[]>();
  for (const entry of allEntries) {
    const list = entriesByDeal.get(entry.deal_id) ?? [];
    list.push(entry);
    entriesByDeal.set(entry.deal_id, list);
  }

  const dealIds = new Set([...deduped.map((l) => l.dealId), ...allEntries.map((e) => e.deal_id)]);
  const dealsMap = new Map<string, ReturnType<typeof buildDealApprovalLocks>>();
  for (const dealId of dealIds) {
    dealsMap.set(dealId, buildDealApprovalLocks(dealId, deduped));
  }

  return { approvedEntryIds, batchRunDateByEntryId, batchRunDateByBatchId, dealsMap, entriesByDeal };
}

function fingerprintAssignment(
  entry: CommissionEntryLike & { id: string },
  ctx: LocalApprovalContext
): DedupedApprovalLock | null {
  const dealLocks = ctx.dealsMap.get(entry.deal_id);
  if (!dealLocks || dealLocks.locks.length === 0) return null;
  const peers = ctx.entriesByDeal.get(entry.deal_id) ?? [];
  return assignFingerprintsToEntries(dealLocks, peers).get(entry.id) ?? null;
}

export function getEntryApprovalSource(
  entry: CommissionEntryLike & { id: string },
  ctx: LocalApprovalContext
): EntryApprovalSource | null {
  if (entry.status === 'paid') return { kind: 'paid' };

  if (ctx.approvedEntryIds.has(entry.id)) {
    return {
      kind: 'batch',
      reportDate: ctx.batchRunDateByEntryId.get(entry.id) ?? 'unknown',
    };
  }

  const lock = fingerprintAssignment(entry, ctx);
  if (!lock) return null;

  const entryMonth = getEntryEffectiveMonth(entry.payable_date, entry.accrual_date, entry.month);
  return {
    kind: 'fingerprint',
    reportDate: ctx.batchRunDateByBatchId.get(lock.batchId) ?? 'unknown',
    approvedMonth: lock.month,
    shifted: entryMonth !== null && lock.month !== entryMonth,
  };
}

export function formatApprovalSourceLabel(source: EntryApprovalSource | null): string | null {
  if (!source) return null;
  if (source.kind === 'paid') return 'Paid';
  if (source.kind === 'batch') return `Report ${source.reportDate}`;
  if (source.shifted) return `Report ${source.reportDate} (approved ${source.approvedMonth})`;
  return `Report ${source.reportDate}`;
}

/** @deprecated Use getLocalApprovalContext */
export type LocalApprovalSets = LocalApprovalContext;

/** @deprecated Use getLocalApprovalContext */
export function getLocalApprovalDisplaySets(db: LocalDb): LocalApprovalContext {
  return getLocalApprovalContext(db);
}

export function isEntryApprovedForDisplay(
  entry: CommissionEntryLike & { id: string },
  ctx: LocalApprovalContext
): boolean {
  return getEntryApprovalSource(entry, ctx) !== null;
}
