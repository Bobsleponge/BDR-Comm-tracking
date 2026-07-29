import 'server-only';

import { getApprovedCommissionProtection } from '@/lib/commission/approved-entry-guard';
import { getEntryEffectiveMonth } from '@/lib/commission/entry-month';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export interface ReconcileRow {
  month: string;
  approvedAmount: number | null;
  liveEntryAmount: number | null;
  fingerprintBlocksBilling: boolean;
  delta: number | null;
  batchId: string | null;
}

export interface DealReconcileResult {
  dealId: string;
  clientName: string;
  rows: ReconcileRow[];
  approvedTotal: number;
  liveTotal: number;
  eligibleWouldIncludeLockedMonths: string[];
}

export async function reconcileDeal(dealId: string): Promise<DealReconcileResult | null> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const deal = db.prepare('SELECT id, client_name FROM deals WHERE id = ?').get(dealId) as
      | { id: string; client_name: string }
      | undefined;
    if (!deal) return null;

    const protection = await getApprovedCommissionProtection(dealId);

    const liveEntries = db.prepare(`
      SELECT payable_date, accrual_date, month, amount
      FROM commission_entries
      WHERE deal_id = ?
    `).all(dealId) as Array<{
      payable_date: string | null;
      accrual_date: string | null;
      month: string | null;
      amount: number;
    }>;

    const liveByMonth = new Map<string, number>();
    for (const entry of liveEntries) {
      const month = getEntryEffectiveMonth(entry.payable_date, entry.accrual_date, entry.month);
      if (!month) continue;
      liveByMonth.set(month, (liveByMonth.get(month) ?? 0) + Number(entry.amount));
    }

    const approvedByMonth = new Map<string, { amount: number; batchId: string }>();
    for (const fp of protection.fingerprints) {
      approvedByMonth.set(fp.month, { amount: fp.amount, batchId: fp.batchId });
    }

    const allMonths = [...new Set([...liveByMonth.keys(), ...approvedByMonth.keys()])].sort();

    const rows: ReconcileRow[] = allMonths.map((month) => {
      const approved = approvedByMonth.get(month);
      const liveAmount = liveByMonth.get(month) ?? null;
      const approvedAmount = approved?.amount ?? null;
      const fingerprintBlocksBilling = !!approved;
      const delta =
        approvedAmount != null && liveAmount != null ? liveAmount - approvedAmount : null;

      return {
        month,
        approvedAmount,
        liveEntryAmount: liveAmount,
        fingerprintBlocksBilling,
        delta,
        batchId: approved?.batchId ?? null,
      };
    });

    const approvedTotal = protection.fingerprints.reduce((sum, fp) => sum + fp.amount, 0);
    const liveTotal = liveEntries.reduce((sum, e) => sum + Number(e.amount), 0);

    const eligibleWouldIncludeLockedMonths = [...approvedByMonth.keys()].filter((month) => {
      const live = liveByMonth.get(month);
      return live != null && live > 0;
    });

    return {
      dealId: deal.id,
      clientName: deal.client_name,
      rows,
      approvedTotal,
      liveTotal,
      eligibleWouldIncludeLockedMonths,
    };
  }

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient() as any;

  const dealResult = await supabase.from('deals').select('id, client_name').eq('id', dealId).single();
  if (dealResult.error || !dealResult.data) return null;

  const protection = await getApprovedCommissionProtection(dealId);

  const { data: liveEntries } = await supabase
    .from('commission_entries')
    .select('payable_date, accrual_date, month, amount')
    .eq('deal_id', dealId);

  const liveByMonth = new Map<string, number>();
  for (const entry of liveEntries || []) {
    const month = getEntryEffectiveMonth(entry.payable_date, entry.accrual_date, entry.month);
    if (!month) continue;
    liveByMonth.set(month, (liveByMonth.get(month) ?? 0) + Number(entry.amount));
  }

  const approvedByMonth = new Map<string, { amount: number; batchId: string }>();
  for (const fp of protection.fingerprints) {
    approvedByMonth.set(fp.month, { amount: fp.amount, batchId: fp.batchId });
  }

  const allMonths = [...new Set([...liveByMonth.keys(), ...approvedByMonth.keys()])].sort();

  const rows: ReconcileRow[] = allMonths.map((month) => {
    const approved = approvedByMonth.get(month);
    const liveAmount = liveByMonth.get(month) ?? null;
    const approvedAmount = approved?.amount ?? null;
    return {
      month,
      approvedAmount,
      liveEntryAmount: liveAmount,
      fingerprintBlocksBilling: !!approved,
      delta: approvedAmount != null && liveAmount != null ? liveAmount - approvedAmount : null,
      batchId: approved?.batchId ?? null,
    };
  });

  const approvedTotal = protection.fingerprints.reduce((sum, fp) => sum + fp.amount, 0);
  const liveTotal = (liveEntries || []).reduce((sum: number, e: any) => sum + Number(e.amount), 0);

  return {
    dealId: dealResult.data.id,
    clientName: dealResult.data.client_name,
    rows,
    approvedTotal,
    liveTotal,
    eligibleWouldIncludeLockedMonths: [...approvedByMonth.keys()].filter((m) => liveByMonth.has(m)),
  };
}
