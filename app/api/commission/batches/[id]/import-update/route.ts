import { NextRequest } from 'next/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { parseCommissionReportBuffer } from '@/lib/commission/import-update/parse-file';
import { buildImportProposal, reinterpretLineWithClarification } from '@/lib/commission/import-update/build-proposal';
import { loadBatchItemsForImport, loadSnapshotItemsForImport } from '@/lib/commission/import-update/load-batch-items';
import type { ImportProposalLine } from '@/lib/commission/import-update/types';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * POST /api/commission/batches/[id]/import-update
 * Multipart: file = boss annotated report
 * JSON body (clarify mode): { line, clarificationAnswer }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    if (!USE_LOCAL_DB) {
      return apiError('Import boss update is currently supported in local DB mode only', 501);
    }

    const contentType = request.headers.get('content-type') ?? '';

    // Clarification re-interpret (JSON)
    if (contentType.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      const { line, clarificationAnswer } = body as {
        line?: ImportProposalLine;
        clarificationAnswer?: string;
      };
      if (!line || !clarificationAnswer?.trim()) {
        return apiError('line and clarificationAnswer required', 400);
      }
      const updated = await reinterpretLineWithClarification(line, clarificationAnswer.trim());
      return apiSuccess({ line: updated });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof Blob)) {
      return apiError('file is required (xlsx or csv)', 400);
    }

    const filename = file instanceof File ? file.name : 'upload.xlsx';
    const buffer = Buffer.from(await file.arrayBuffer());

    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const batch = db.prepare('SELECT * FROM commission_batches WHERE id = ?').get(id) as
      | { id: string; bdr_id: string; status: string; payable_cutoff?: string | null; run_date?: string }
      | undefined;
    if (!batch) {
      return apiError('Batch not found', 404);
    }

    const canAccess = await canAccessBdr(batch.bdr_id);
    if (!canAccess) {
      return apiError('Forbidden', 403);
    }

    const bossRows = parseCommissionReportBuffer(buffer, filename);
    if (bossRows.length === 0) {
      return apiError('No data rows found in uploaded file', 400);
    }

    const batchItems =
      batch.status === 'draft'
        ? loadBatchItemsForImport(db, id)
        : loadSnapshotItemsForImport(db, id);

    if (batchItems.length === 0) {
      return apiError('Batch has no items to compare against', 400);
    }

    const proposal = await buildImportProposal({
      batchId: id,
      batchStatus: batch.status,
      bossRows,
      batchItems,
    });

    return apiSuccess({
      proposal,
      requiresDraftToApply: batch.status !== 'draft',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Import analysis failed';
    if (process.env.NODE_ENV === 'development') {
      console.error('import-update POST error:', error);
    }
    return apiError(message, 500);
  }
}
