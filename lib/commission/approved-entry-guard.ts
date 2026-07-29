import 'server-only';

import { getEntryEffectiveMonth } from '@/lib/commission/entry-month';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export interface ApprovedFingerprint {
  effectiveDate: string;
  month: string;
  amount: number;
  batchId: string;
}

export interface ApprovedCommissionProtection {
  blocked: boolean;
  approvedMonths: string[];
  batchIds: string[];
  fingerprints: ApprovedFingerprint[];
}

function buildProtection(fingerprints: ApprovedFingerprint[], batchIdsFromEntries: string[]): ApprovedCommissionProtection {
  const batchIds = [...new Set([...fingerprints.map((f) => f.batchId), ...batchIdsFromEntries])];
  const approvedMonths = [...new Set(fingerprints.map((f) => f.month))].sort();
  return {
    blocked: fingerprints.length > 0 || batchIdsFromEntries.length > 0,
    approvedMonths,
    batchIds,
    fingerprints,
  };
}

/**
 * Returns approved commission protection for a deal.
 * Fingerprints survive reprocessing; live batch_items may be gone after deal edits.
 */
export async function getApprovedCommissionProtection(dealId: string): Promise<ApprovedCommissionProtection> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const fpRows = db.prepare(`
      SELECT effective_date, amount, batch_id
      FROM approved_commission_fingerprints
      WHERE deal_id = ?
      ORDER BY effective_date
    `).all(dealId) as Array<{ effective_date: string; amount: number; batch_id: string }>;

    const fingerprints: ApprovedFingerprint[] = fpRows.map((row) => ({
      effectiveDate: row.effective_date,
      month: getEntryEffectiveMonth(row.effective_date) ?? row.effective_date.slice(0, 7),
      amount: Number(row.amount),
      batchId: row.batch_id,
    }));

    const batchRows = db.prepare(`
      SELECT DISTINCT cb.id as batch_id
      FROM commission_entries ce
      JOIN commission_batch_items cbi ON cbi.commission_entry_id = ce.id
      JOIN commission_batches cb ON cbi.batch_id = cb.id
      WHERE ce.deal_id = ? AND cb.status IN ('approved', 'paid')
    `).all(dealId) as Array<{ batch_id: string }>;

    return buildProtection(
      fingerprints,
      batchRows.map((r) => r.batch_id)
    );
  }

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient() as any;

  const { data: fpRows } = await supabase
    .from('approved_commission_fingerprints')
    .select('effective_date, amount, batch_id')
    .eq('deal_id', dealId)
    .order('effective_date');

  const fingerprints: ApprovedFingerprint[] = (fpRows || []).map((row: any) => ({
    effectiveDate: row.effective_date,
    month: getEntryEffectiveMonth(row.effective_date) ?? String(row.effective_date).slice(0, 7),
    amount: Number(row.amount),
    batchId: row.batch_id,
  }));

  const { data: dealEntries } = await supabase.from('commission_entries').select('id').eq('deal_id', dealId);
  const entryIds = (dealEntries || []).map((e: any) => e.id);
  const batchIdsFromEntries: string[] = [];

  if (entryIds.length > 0) {
    const { data: cbiRows } = await supabase
      .from('commission_batch_items')
      .select('batch_id')
      .in('commission_entry_id', entryIds);
    const batchIds = [...new Set((cbiRows || []).map((r: any) => r.batch_id))];
    if (batchIds.length > 0) {
      const { data: batchStatuses } = await supabase
        .from('commission_batches')
        .select('id, status')
        .in('id', batchIds);
      for (const b of batchStatuses || []) {
        if (['approved', 'paid'].includes(b.status)) {
          batchIdsFromEntries.push(b.id);
        }
      }
    }
  }

  return buildProtection(fingerprints, batchIdsFromEntries);
}

/** @deprecated Use getApprovedCommissionProtection */
export async function hasApprovedCommissionProtection(dealId: string): Promise<ApprovedCommissionProtection> {
  return getApprovedCommissionProtection(dealId);
}
