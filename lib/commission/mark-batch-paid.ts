import 'server-only';

import { invalidateApprovalLockCache } from '@/lib/commission/approval-lock-store';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export interface MarkBatchPaidResult {
  batchId: string;
  entriesMarkedPaid: number;
}

/**
 * Mark an approved commission report as paid and sync entry statuses.
 */
export async function markCommissionBatchPaid(batchId: string): Promise<MarkBatchPaidResult> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const batch = db.prepare('SELECT id, status FROM commission_batches WHERE id = ?').get(batchId) as
      | { id: string; status: string }
      | undefined;
    if (!batch) {
      throw new Error('Batch not found');
    }
    if (batch.status !== 'approved') {
      throw new Error('Only approved reports can be marked as paid');
    }

    const entryIds = db
      .prepare('SELECT commission_entry_id FROM commission_batch_items WHERE batch_id = ?')
      .all(batchId) as { commission_entry_id: string }[];

    const markPaid = db.prepare(`
      UPDATE commission_entries SET status = 'paid', updated_at = datetime('now') WHERE id = ?
    `);

    let entriesMarkedPaid = 0;
    for (const { commission_entry_id } of entryIds) {
      markPaid.run(commission_entry_id);
      entriesMarkedPaid++;
    }

    db.prepare(`
      UPDATE commission_batches SET status = 'paid', updated_at = datetime('now') WHERE id = ?
    `).run(batchId);

    invalidateApprovalLockCache();

    return { batchId, entriesMarkedPaid };
  }

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();

  const { data: batch, error: batchError } = await supabase
    .from('commission_batches')
    .select('id, status')
    .eq('id', batchId)
    .single();

  if (batchError || !batch) {
    throw new Error('Batch not found');
  }
  if (batch.status !== 'approved') {
    throw new Error('Only approved reports can be marked as paid');
  }

  const { data: items } = await supabase
    .from('commission_batch_items')
    .select('commission_entry_id')
    .eq('batch_id', batchId);

  const entryIds = (items ?? []).map((i: { commission_entry_id: string }) => i.commission_entry_id);
  if (entryIds.length > 0) {
    await supabase.from('commission_entries').update({ status: 'paid' }).in('id', entryIds);
  }

  const { error: updateError } = await supabase
    .from('commission_batches')
    .update({ status: 'paid' })
    .eq('id', batchId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  invalidateApprovalLockCache();

  return { batchId, entriesMarkedPaid: entryIds.length };
}
