import 'server-only';

import {
  isEntryApprovalSettled,
  settlementBatchStatus,
} from '@/lib/commission/approval-lock';
import { getDealApprovalLocks, invalidateApprovalLockCache, loadDealEntries } from '@/lib/commission/approval-lock-store';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export interface SyncSettlementResult {
  dealId: string;
  markedPaid: number;
  markedApproved: number;
  unchanged: number;
}

/**
 * Mark live commission entries as paid when they match approval locks (month or amount quota).
 * Runs after safe reprocess so shifted payable dates still show as settled.
 */
export async function syncApprovalSettlementForDeal(dealId: string): Promise<SyncSettlementResult> {
  const dealLocks = await getDealApprovalLocks(dealId);
  if (dealLocks.locks.length === 0) {
    return { dealId, markedPaid: 0, markedApproved: 0, unchanged: 0 };
  }

  const entries = await loadDealEntries(dealId);
  let markedPaid = 0;
  let markedApproved = 0;
  let unchanged = 0;

  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();
    const update = db.prepare(`
      UPDATE commission_entries SET status = ?, updated_at = datetime('now') WHERE id = ?
    `);

    for (const entry of entries) {
      if (entry.status === 'paid' || entry.status === 'cancelled' || entry.status === 'ignored') {
        unchanged++;
        continue;
      }

      if (!isEntryApprovalSettled(entry, dealLocks, entries)) {
        unchanged++;
        continue;
      }

      const batchStatus = settlementBatchStatus(entry, dealLocks, entries);
      if (batchStatus === 'paid') {
        update.run('paid', entry.id);
        markedPaid++;
      } else {
        markedApproved++;
      }
    }
  } else {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient() as any;

    for (const entry of entries) {
      if (entry.status === 'paid' || entry.status === 'cancelled' || entry.status === 'ignored') {
        unchanged++;
        continue;
      }

      if (!isEntryApprovalSettled(entry, dealLocks, entries)) {
        unchanged++;
        continue;
      }

      const batchStatus = settlementBatchStatus(entry, dealLocks, entries);
      if (batchStatus === 'paid') {
        await supabase.from('commission_entries').update({ status: 'paid' }).eq('id', entry.id);
        markedPaid++;
      } else {
        markedApproved++;
      }
    }
  }

  return { dealId, markedPaid, markedApproved, unchanged };
}

export async function syncApprovalSettlementForAllDeals(): Promise<SyncSettlementResult[]> {
  invalidateApprovalLockCache();
  const { getAllDealApprovalLocksMap } = await import('@/lib/commission/approval-lock-store');
  const map = await getAllDealApprovalLocksMap();
  const results: SyncSettlementResult[] = [];

  for (const dealId of map.keys()) {
    results.push(await syncApprovalSettlementForDeal(dealId));
  }

  return results;
}
