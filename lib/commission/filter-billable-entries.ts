import {
  buildDealApprovalLocks,
  dedupeFingerprints,
  isEntryBillable,
  type CommissionEntryLike,
  type RawFingerprint,
} from '@/lib/commission/approval-lock';

export function buildBillableFilterContext(
  fingerprints: RawFingerprint[],
  allEntries: CommissionEntryLike[]
): {
  dealsMap: Map<string, ReturnType<typeof buildDealApprovalLocks>>;
  entriesByDeal: Map<string, CommissionEntryLike[]>;
} {
  const deduped = dedupeFingerprints(fingerprints);
  const entriesByDeal = new Map<string, CommissionEntryLike[]>();

  for (const entry of allEntries) {
    const list = entriesByDeal.get(entry.deal_id) ?? [];
    list.push(entry);
    entriesByDeal.set(entry.deal_id, list);
  }

  const dealIds = new Set([
    ...deduped.map((l) => l.dealId),
    ...allEntries.map((e) => e.deal_id),
  ]);

  const dealsMap = new Map<string, ReturnType<typeof buildDealApprovalLocks>>();
  for (const dealId of dealIds) {
    dealsMap.set(dealId, buildDealApprovalLocks(dealId, deduped));
  }

  return { dealsMap, entriesByDeal };
}

export function isEntryBillableWithContext(
  entry: CommissionEntryLike,
  ctx: ReturnType<typeof buildBillableFilterContext>
): boolean {
  const dealLocks = ctx.dealsMap.get(entry.deal_id);
  if (!dealLocks || dealLocks.locks.length === 0) return true;
  const peers = ctx.entriesByDeal.get(entry.deal_id) ?? [];
  return isEntryBillable(entry, dealLocks, peers);
}

/** Build filter context from a local SQLite database handle. */
export function buildLocalBillableFilterContext(db: {
  prepare: (sql: string) => {
    all: (...args: unknown[]) => unknown[];
  };
}): ReturnType<typeof buildBillableFilterContext> {
  const fingerprints = db
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

  return buildBillableFilterContext(fingerprints, allEntries);
}

export function filterBillableEntries<T extends CommissionEntryLike>(
  entries: T[],
  ctx: ReturnType<typeof buildBillableFilterContext>
): T[] {
  return entries.filter((e) => isEntryBillableWithContext(e, ctx));
}
