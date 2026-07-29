import { NextRequest } from 'next/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { markCommissionBatchPaid } from '@/lib/commission/mark-batch-paid';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * POST /api/commission/batches/[id]/mark-paid
 * Record that payment was sent for an approved report.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const batch = db.prepare('SELECT bdr_id FROM commission_batches WHERE id = ?').get(id) as
        | { bdr_id: string }
        | undefined;
      if (!batch) {
        return apiError('Batch not found', 404);
      }
      const canAccess = await canAccessBdr(batch.bdr_id);
      if (!canAccess) {
        return apiError('Forbidden', 403);
      }
    } else {
      const { createClient } = await import('@/lib/supabase/server');
      const supabase = await createClient();
      const { data: batch } = await supabase.from('commission_batches').select('bdr_id').eq('id', id).single();
      if (!batch) {
        return apiError('Batch not found', 404);
      }
      const canAccess = await canAccessBdr(batch.bdr_id);
      if (!canAccess) {
        return apiError('Forbidden', 403);
      }
    }

    const result = await markCommissionBatchPaid(id);

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const updated = db.prepare('SELECT * FROM commission_batches WHERE id = ?').get(id);
      return apiSuccess({ ...updated, entries_marked_paid: result.entriesMarkedPaid });
    }

    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    const { data: updated } = await supabase.from('commission_batches').select('*').eq('id', id).single();
    return apiSuccess({ ...updated, entries_marked_paid: result.entriesMarkedPaid });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unauthorized';
    if (message === 'Batch not found') {
      return apiError(message, 404);
    }
    if (message === 'Only approved reports can be marked as paid') {
      return apiError(message, 400);
    }
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission batch mark-paid error:', error);
    }
    return apiError(message, 401);
  }
}
