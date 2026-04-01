import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * GET /api/commission/eligible
 * Fetch entries eligible for a new report pull (preview before generating).
 * Query: bdr_id (optional; admin only). Non-admin uses current user's BDR.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    let targetBdrId = bdrId;
    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      targetBdrId = userBdrId;
    }

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Billable = due for payment AND not in an accepted (approved/paid) report
      // Exclude: commission_batch_items + approved_commission_fingerprints (survives reprocessing)
      let query = `
        SELECT 
          ce.id,
          ce.deal_id,
          ce.amount,
          ce.status,
          ce.accrual_date,
          ce.payable_date,
          ce.month,
          d.client_name,
          d.service_type as deal_service_type,
          ds.id as service_id,
          ds.service_name,
          ds.commission_rate,
          ds.billing_type,
          re.collection_date,
          re.amount_collected
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        LEFT JOIN deal_services ds ON re.service_id = ds.id
        WHERE ce.status IN ('payable', 'accrued', 'pending')
          AND COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01') <= date('now')
          AND (ce.invoiced_batch_id IS NULL OR ce.invoiced_batch_id = '')
          AND NOT EXISTS (
            SELECT 1 FROM commission_batch_items cbi
            JOIN commission_batches cb ON cbi.batch_id = cb.id
            WHERE cbi.commission_entry_id = ce.id AND cb.status IN ('approved', 'paid')
          )
          AND NOT EXISTS (
            SELECT 1 FROM approved_commission_fingerprints acf
            WHERE acf.bdr_id = ce.bdr_id AND acf.deal_id = ce.deal_id
              AND substr(acf.effective_date, 1, 7) = substr(COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01'), 1, 7)
          )
          AND d.cancellation_date IS NULL
      `;
      const params: any[] = [];
      if (targetBdrId) {
        query += ' AND ce.bdr_id = ?';
        params.push(targetBdrId);
      }
      query += ' ORDER BY COALESCE(ce.payable_date, ce.accrual_date, ce.month) ASC';

      const entries = db.prepare(query).all(...params) as any[];

      return apiSuccess({
        data: entries,
        count: entries.length,
      }, 200, { cache: 'no-store' });
    }

    // Supabase mode: billable = due for payment, not in any batch (accepted report)
    const supabase = await createClient();

    const today = new Date().toISOString().split('T')[0];
    let query = supabase
      .from('commission_entries')
      .select(`
        id,
        deal_id,
        amount,
        status,
        accrual_date,
        payable_date,
        month,
        deals!inner(client_name, service_type, cancellation_date),
        revenue_events(collection_date, amount_collected, deal_services(service_name, commission_rate, billing_type))
      `)
      .in('status', ['payable', 'accrued', 'pending'])
      .is('invoiced_batch_id', null)
      .is('deals.cancellation_date', null)
      .order('payable_date', { ascending: true, nullsFirst: false })
      .order('accrual_date', { ascending: true, nullsFirst: false });

    if (targetBdrId) {
      query = query.eq('bdr_id', targetBdrId);
    }

    const { data, error } = await query;

    if (error) {
      return apiError(error.message, 500);
    }

    // Filter where payable_date or accrual_date or month <= today, and amount is set (exclude placeholder reminders)
    let entries = (data || []).filter((entry: any) => {
      const effectiveDate = entry.payable_date
        || entry.accrual_date
        || (entry.month ? `${entry.month}-01` : null);
      return effectiveDate && effectiveDate <= today;
    });

    // Exclude entries already in approved/paid reports
    const { data: approvedBatches } = await supabase
      .from('commission_batches')
      .select('id')
      .in('status', ['approved', 'paid']);
    const approvedBatchIds = (approvedBatches || []).map((b: any) => b.id);
    if (approvedBatchIds.length > 0) {
      const { data: items } = await supabase
        .from('commission_batch_items')
        .select('commission_entry_id')
        .in('batch_id', approvedBatchIds);
      const alreadyApprovedIds = new Set((items || []).map((i: any) => i.commission_entry_id));
      entries = entries.filter((e: any) => !alreadyApprovedIds.has(e.id));
    }

    // Exclude by approved_commission_fingerprints (survives reprocessing)
    // Match on (deal_id, month yyyy-MM) - if we paid that deal+month, exclude regardless of exact date (handles format differences)
    let fpQuery = supabase.from('approved_commission_fingerprints').select('deal_id, effective_date');
    if (targetBdrId) fpQuery = fpQuery.eq('bdr_id', targetBdrId);
    const { data: fps } = await fpQuery;
    const fpSet = new Set((fps || [])
      .filter((f: any) => f.effective_date)
      .map((f: any) => `${f.deal_id}|${String(f.effective_date).slice(0, 7)}`));
    entries = entries.filter((e: any) => {
      const ed = e.payable_date || e.accrual_date || (e.month ? `${e.month}-01` : null);
      if (!ed) return true;
      const monthKey = String(ed).slice(0, 7);
      return !fpSet.has(`${e.deal_id}|${monthKey}`);
    });

    return apiSuccess({
      data: entries,
      count: entries.length,
    }, 200, { cache: 'no-store' });
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission eligible API error:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}
