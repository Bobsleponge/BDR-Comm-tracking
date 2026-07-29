import 'server-only';

import {
  buildDealApprovalLocks,
  dedupeFingerprints,
  type DealApprovalLocks,
  type RawFingerprint,
} from '@/lib/commission/approval-lock';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

let cachedAllLocks: ReturnType<typeof dedupeFingerprints> | null = null;

export function invalidateApprovalLockCache(): void {
  cachedAllLocks = null;
}

async function loadAllLocks(): Promise<ReturnType<typeof dedupeFingerprints>> {
  if (cachedAllLocks) return cachedAllLocks;

  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();
    const rows = db.prepare(`
      SELECT acf.bdr_id, acf.deal_id, acf.effective_date, acf.amount, acf.batch_id, cb.status as batch_status
      FROM approved_commission_fingerprints acf
      LEFT JOIN commission_batches cb ON cb.id = acf.batch_id
    `).all() as RawFingerprint[];
    cachedAllLocks = dedupeFingerprints(rows);
    return cachedAllLocks;
  }

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient() as any;
  const { data: rows } = await supabase
    .from('approved_commission_fingerprints')
    .select('bdr_id, deal_id, effective_date, amount, batch_id, commission_batches(status)');

  const normalized: RawFingerprint[] = (rows || []).map((r: any) => ({
    bdr_id: r.bdr_id,
    deal_id: r.deal_id,
    effective_date: r.effective_date,
    amount: Number(r.amount),
    batch_id: r.batch_id,
    batch_status: r.commission_batches?.status,
  }));

  cachedAllLocks = dedupeFingerprints(normalized);
  return cachedAllLocks;
}

export async function getDealApprovalLocks(dealId: string): Promise<DealApprovalLocks> {
  const all = await loadAllLocks();
  return buildDealApprovalLocks(dealId, all);
}

export async function getAllDealApprovalLocksMap(): Promise<Map<string, DealApprovalLocks>> {
  const all = await loadAllLocks();
  const dealIds = [...new Set(all.map((l) => l.dealId))];
  const map = new Map<string, DealApprovalLocks>();
  for (const dealId of dealIds) {
    map.set(dealId, buildDealApprovalLocks(dealId, all));
  }
  return map;
}

export async function loadDealEntries(dealId: string): Promise<
  Array<{
    id: string;
    bdr_id: string;
    deal_id: string;
    amount: number;
    payable_date: string | null;
    accrual_date: string | null;
    month: string | null;
    status: string | null;
  }>
> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();
    return db.prepare(`
      SELECT id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status
      FROM commission_entries WHERE deal_id = ?
    `).all(dealId) as any[];
  }

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient() as any;
  const { data } = await supabase
    .from('commission_entries')
    .select('id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status')
    .eq('deal_id', dealId);
  return data || [];
}
