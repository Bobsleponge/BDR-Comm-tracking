import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { applyChangesSequential } from '@/lib/commission/batch-actions-local';
import type { ApplyChangePayload } from '@/lib/commission/import-update/types';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * POST /api/commission/batches/[id]/apply-update
 * Body: { changes: ApplyChangePayload[] }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    if (!USE_LOCAL_DB) {
      return apiError('Apply boss update is currently supported in local DB mode only', 501);
    }

    const body = await request.json().catch(() => ({}));
    const changes = (body as { changes?: ApplyChangePayload[] }).changes;
    if (!Array.isArray(changes) || changes.length === 0) {
      return apiError('changes array is required', 400);
    }

    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const batch = db.prepare('SELECT * FROM commission_batches WHERE id = ?').get(id) as
      | { id: string; bdr_id: string; status: string; payable_cutoff?: string | null; run_date?: string }
      | undefined;
    if (!batch) {
      return apiError('Batch not found', 404);
    }
    if (batch.status !== 'draft') {
      return NextResponse.json(
        { error: 'Batch must be in draft status to apply changes. Revert to draft first.', requiresDraft: true },
        { status: 400 }
      );
    }

    const canAccess = await canAccessBdr(batch.bdr_id);
    if (!canAccess) {
      return apiError('Forbidden', 403);
    }

    const results = await applyChangesSequential(db, id, batch, changes);
    const failed = results.filter((r) => !r.success);
    const applied = results.filter((r) => r.success);

    return apiSuccess({
      success: failed.length === 0,
      applied_count: applied.length,
      failed_count: failed.length,
      results,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Apply update failed';
    if (process.env.NODE_ENV === 'development') {
      console.error('apply-update POST error:', error);
    }
    return apiError(message, 500);
  }
}
