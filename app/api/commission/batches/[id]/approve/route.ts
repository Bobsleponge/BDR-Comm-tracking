import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * POST /api/commission/batches/[id]/approve
 * Approve and finalize report. Lock batch; no further edits.
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
      if (batch.status !== 'draft') {
        return apiError('Batch is not in draft status; cannot approve', 400);
      }

      const canAccess = await canAccessBdr(batch.bdr_id);
      if (!canAccess) {
        return apiError('Forbidden', 403);
      }

      // Store fingerprints before status update (survives reprocessing; batch_items CASCADE when entries deleted)
      const { generateUUID } = await import('@/lib/utils/uuid');
      const items = db.prepare(`
        SELECT cbi.commission_entry_id, cbi.override_amount, ce.bdr_id, ce.deal_id, ce.payable_date, ce.accrual_date, ce.month, ce.amount
        FROM commission_batch_items cbi
        JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
        WHERE cbi.batch_id = ?
      `).all(id) as any[];
      const insertFp = db.prepare(`
        INSERT INTO approved_commission_fingerprints (id, bdr_id, deal_id, effective_date, amount, batch_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const i of items) {
        const effectiveDate = i.payable_date || i.accrual_date || (i.month ? `${i.month}-01` : null);
        const amount = i.override_amount ?? i.amount;
        if (effectiveDate != null && amount != null) {
          insertFp.run(generateUUID(), i.bdr_id, i.deal_id, effectiveDate, amount, id);
        }
      }

      // Snapshot report rows for immutability (survives reprocessing CASCADE)
      const snapshotItems = db.prepare(`
        SELECT
          cbi.override_amount,
          cbi.override_payment_date,
          cbi.override_commission_rate,
          ce.amount as original_amount,
          ce.payable_date,
          ce.accrual_date,
          d.client_name,
          d.service_type as deal_service_type,
          d.deal_value,
          d.original_deal_value,
          d.is_renewal as deal_is_renewal,
          ds.service_name,
          ds.commission_rate,
          ds.is_renewal as service_is_renewal,
          ds.original_service_value,
          ds.commissionable_value,
          re.billing_type as re_billing_type,
          re.collection_date,
          re.amount_collected
        FROM commission_batch_items cbi
        JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
        JOIN deals d ON ce.deal_id = d.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        LEFT JOIN deal_services ds ON re.service_id = ds.id
        WHERE cbi.batch_id = ?
      `).all(id) as any[];
      const { buildExportRows } = await import('@/lib/commission/export-rows');
      const snapshotRows = buildExportRows(snapshotItems);
      db.prepare(`
        INSERT INTO commission_batch_snapshots (id, batch_id, snapshot_data)
        VALUES (?, ?, ?)
      `).run(generateUUID(), id, JSON.stringify(snapshotRows));

      db.prepare(`
        UPDATE commission_batches SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(id);

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
    if (batch.status !== 'draft') {
      return apiError('Batch is not in draft status; cannot approve', 400);
    }

    const canAccess = await canAccessBdr(batch.bdr_id);
    if (!canAccess) {
      return apiError('Forbidden', 403);
    }

    // Store fingerprints before status update (survives reprocessing)
    const { data: items } = await supabase
      .from('commission_batch_items')
      .select('commission_entry_id, override_amount, commission_entries(bdr_id, deal_id, payable_date, accrual_date, month, amount)')
      .eq('batch_id', id);
    if (items && items.length > 0) {
      const fingerprints = items
        .map((i: any) => {
          const ce = i.commission_entries;
          const effectiveDate = ce?.payable_date || ce?.accrual_date || (ce?.month ? `${ce.month}-01` : null);
          const amount = i.override_amount ?? ce?.amount;
          if (effectiveDate && amount != null) {
            return { bdr_id: ce.bdr_id, deal_id: ce.deal_id, effective_date: effectiveDate, amount: Number(amount), batch_id: id };
          }
          return null;
        })
        .filter(Boolean);
      if (fingerprints.length > 0) {
        await supabase.from('approved_commission_fingerprints').insert(fingerprints);
      }
    }

    // Snapshot report rows for immutability
    const { data: snapshotItems } = await supabase
      .from('commission_batch_items')
      .select(`
        override_amount,
        override_payment_date,
        override_commission_rate,
        commission_entries(
          amount,
          payable_date,
          accrual_date,
          deals(client_name, service_type, deal_value, original_deal_value, is_renewal),
          revenue_events(billing_type, collection_date, amount_collected, deal_services(service_name, commission_rate, is_renewal, original_service_value, commissionable_value))
        )
      `)
      .eq('batch_id', id);
    if (snapshotItems && snapshotItems.length > 0) {
      const { buildExportRows, flattenSupabaseItem } = await import('@/lib/commission/export-rows');
      const flatItems = snapshotItems.map((i: any) => flattenSupabaseItem(i));
      const snapshotRows = buildExportRows(flatItems);
      await supabase.from('commission_batch_snapshots').insert({
        batch_id: id,
        snapshot_data: snapshotRows,
      });
    }

    const { data: updated, error } = await supabase
      .from('commission_batches')
      .update({ status: 'approved' })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(updated);
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission batch approve error:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}
