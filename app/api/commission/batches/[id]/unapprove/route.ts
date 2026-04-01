import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * POST /api/commission/batches/[id]/unapprove
 * Revert an approved report back to draft so it can be edited and re-approved.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const batch = db.prepare('SELECT * FROM commission_batches WHERE id = ?').get(id) as any;
      if (!batch) {
        return apiError('Batch not found', 404);
      }
      if (batch.status !== 'approved') {
        return apiError('Only approved reports can be reverted to draft', 400);
      }

      const canAccess = await canAccessBdr(batch.bdr_id);
      if (!canAccess) {
        return apiError('Forbidden', 403);
      }

      // Remove fingerprints and snapshots so entries show as pending and become eligible for new reports
      db.prepare('DELETE FROM approved_commission_fingerprints WHERE batch_id = ?').run(id);
      db.prepare('DELETE FROM commission_batch_snapshots WHERE batch_id = ?').run(id);
      db.prepare(`UPDATE commission_batches SET status = 'draft' WHERE id = ?`).run(id);

      const updated = db.prepare('SELECT * FROM commission_batches WHERE id = ?').get(id) as any;
      return apiSuccess(updated);
    }

    // Supabase mode
    const supabase = await createClient();

    const { data: batch, error: batchError } = await supabase
      .from('commission_batches')
      .select('*')
      .eq('id', id)
      .single();

    if (batchError || !batch) {
      return apiError('Batch not found', 404);
    }
    if (batch.status !== 'approved') {
      return apiError('Only approved reports can be reverted to draft', 400);
    }

    const canAccess = await canAccessBdr(batch.bdr_id);
    if (!canAccess) {
      return apiError('Forbidden', 403);
    }

    // Remove fingerprints and snapshots so entries show as pending and become eligible for new reports
    await supabase.from('approved_commission_fingerprints').delete().eq('batch_id', id);
    await supabase.from('commission_batch_snapshots').delete().eq('batch_id', id);

    const { data: updated, error } = await supabase
      .from('commission_batches')
      .update({ status: 'draft' })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(updated);
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission batch unapprove error:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}
