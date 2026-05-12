/**
 * Single place for "is this commission line approved / settled for UI?" (local SQLite).
 * Aligns commission entries list + monthly breakdown.
 */
import { getLocalDB } from '@/lib/db/local-db';

type LocalDb = ReturnType<typeof getLocalDB>;

export function normDateStr(d: string | null | undefined): string | null {
  if (d == null || d === '') return null;
  const s = String(d).trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

export type LocalApprovalSets = {
  approvedEntryIds: Set<string>;
  fpSet: Set<string>;
  fpMonthSet: Set<string>;
};

export function getLocalApprovalDisplaySets(db: LocalDb): LocalApprovalSets {
  const approvedRows = db
    .prepare(
      `
    SELECT cbi.commission_entry_id AS id
    FROM commission_batch_items cbi
    INNER JOIN commission_batches cb ON cbi.batch_id = cb.id
    WHERE cb.status IN ('approved', 'paid')
  `
    )
    .all() as { id: string }[];
  const approvedEntryIds = new Set(approvedRows.map((r) => r.id));

  const fingerprints = db
    .prepare('SELECT bdr_id, deal_id, effective_date FROM approved_commission_fingerprints')
    .all() as Array<{ bdr_id: string; deal_id: string; effective_date: string }>;

  const fpSet = new Set(
    fingerprints.map((f) => `${f.bdr_id}|${f.deal_id}|${normDateStr(f.effective_date) || f.effective_date}`)
  );
  const fpMonthSet = new Set(
    fingerprints
      .map((f) => {
        const nd = normDateStr(f.effective_date);
        const ym = nd && nd.length >= 7 ? nd.slice(0, 7) : '';
        return ym ? `${f.bdr_id}|${f.deal_id}|${ym}` : '';
      })
      .filter(Boolean)
  );

  return { approvedEntryIds, fpSet, fpMonthSet };
}

export function isEntryApprovedForDisplay(
  entry: {
    id: string;
    bdr_id: string;
    deal_id: string;
    status?: string | null;
    payable_date?: string | null;
    accrual_date?: string | null;
    month?: string | null;
  },
  sets: LocalApprovalSets
): boolean {
  if (entry.status === 'paid') return true;
  if (sets.approvedEntryIds.has(entry.id)) return true;

  const effRaw = entry.payable_date || entry.accrual_date || (entry.month ? `${entry.month}-01` : null);
  const eff = normDateStr(effRaw) || effRaw;
  if (!eff || typeof eff !== 'string') return false;
  const monthKey = eff.length >= 7 ? `${entry.bdr_id}|${entry.deal_id}|${eff.slice(0, 7)}` : '';
  return (
    sets.fpSet.has(`${entry.bdr_id}|${entry.deal_id}|${eff}`) || (!!monthKey && sets.fpMonthSet.has(monthKey))
  );
}
