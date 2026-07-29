import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import {
  normDateStr,
  getLocalApprovalContext,
  isEntryApprovedForDisplay,
  getEntryApprovalSource,
  formatApprovalSourceLabel,
} from '@/lib/commission/entry-approval-display';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');
    const status = searchParams.get('status');
    const month = searchParams.get('month');
    const payableMonth = searchParams.get('payable_month'); // Format: YYYY-MM
    const includeReportAdjustments = searchParams.get('include_report_adjustments') === '1';

    // Pagination parameters
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '100', 10)));
    const offset = (page - 1) * limit;

    const { isAdmin } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    if (USE_LOCAL_DB) {
      // Local DB mode
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Determine which BDR to query
      let targetBdrId = bdrId;
      if (!isUserAdmin) {
        const { getBdrIdFromUser } = await import('@/lib/utils/auth');
        const userBdrId = await getBdrIdFromUser();
        if (!userBdrId) {
          return apiError('BDR profile not found', 404);
        }
        targetBdrId = userBdrId;
      }

      // Build query with JOINs to avoid N+1 queries
      // Include deal_services to get service_name for each commission entry
      let query = `
        SELECT 
          ce.*,
          d.client_name as deals_client_name,
          d.service_type as deals_service_type,
          d.is_renewal as deals_is_renewal,
          br.name as bdr_reps_name,
          br.email as bdr_reps_email,
          re.id as revenue_events_id,
          re.service_id as revenue_events_service_id,
          re.amount_collected as revenue_events_amount_collected,
          re.collection_date as revenue_events_collection_date,
          re.billing_type as revenue_events_billing_type,
          re.payment_stage as revenue_events_payment_stage,
          ds.service_name as deal_services_service_name,
          ds.is_renewal as deal_services_is_renewal
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        LEFT JOIN bdr_reps br ON ce.bdr_id = br.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
        WHERE d.cancellation_date IS NULL
      `;
      const params: any[] = [];

      if (targetBdrId) {
        query += ' AND ce.bdr_id = ?';
        params.push(targetBdrId);
      }

      if (status) {
        query += ' AND ce.status = ?';
        params.push(status);
      }

      if (month) {
        query += ' AND ce.month = ?';
        params.push(month);
      }

      if (payableMonth) {
        // Filter by payable month (payable_date, accrual_date, or month)
        query += " AND strftime('%Y-%m', COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01')) = ?";
        params.push(payableMonth);
      }

      query += ' ORDER BY COALESCE(ce.payable_date, ce.accrual_date, ce.month) DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const entries = db.prepare(query).all(...params) as any[];

      const { buildPaymentSequenceMapLocal, lookupPaymentSequence } = await import(
        '@/lib/commission/enrich-payment-sequence'
      );
      const paymentSeqMap = buildPaymentSequenceMapLocal(
        db,
        entries.map((e: { id: string; service_id?: string; revenue_events_id?: string; revenue_events_service_id?: string }) => ({
          commission_entry_id: e.id,
          revenue_event_id: e.revenue_events_id ?? null,
          service_id: e.revenue_events_service_id ?? e.service_id ?? null,
        }))
      );

      const approvalSets = getLocalApprovalContext(db);

      let adjustmentByEntryId = new Map<string, import('@/lib/commission/export-rows').ReportAdjustmentMeta>();
      if (includeReportAdjustments) {
        const { mergeSnapshotsIntoAdjustmentMap } = await import('@/lib/commission/export-rows');
        const snaps = db
          .prepare('SELECT batch_id, snapshot_data FROM commission_batch_snapshots')
          .all() as Array<{ batch_id: string; snapshot_data: string }>;
        for (const s of snaps) {
          try {
            mergeSnapshotsIntoAdjustmentMap(JSON.parse(s.snapshot_data), s.batch_id, adjustmentByEntryId);
          } catch {
            /* ignore malformed */
          }
        }
      }

      // Get total count for pagination metadata
      let countQuery = `
        SELECT COUNT(*) as total
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        WHERE d.cancellation_date IS NULL
      `;
      const countParams: any[] = [];
      
      if (targetBdrId) {
        countQuery += ' AND ce.bdr_id = ?';
        countParams.push(targetBdrId);
      }
      if (status) {
        countQuery += ' AND ce.status = ?';
        countParams.push(status);
      }
      if (month) {
        countQuery += ' AND ce.month = ?';
        countParams.push(month);
      }
      if (payableMonth) {
        countQuery += " AND strftime('%Y-%m', COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01')) = ?";
        countParams.push(payableMonth);
      }
      
      const totalResult = db.prepare(countQuery).get(...countParams) as { total: number };
      const total = totalResult?.total || 0;

      // Transform results to match expected format (only include essential fields)
      const entriesWithRelations = entries.map(entry => {
        const serviceIsRenewal = entry.deal_services_is_renewal === 1 || entry.deal_services_is_renewal === true;
        const dealIsRenewal = entry.deals_is_renewal === 1 || entry.deals_is_renewal === true;
        const isRenewal = serviceIsRenewal || dealIsRenewal;
        const entryForApproval = {
          id: entry.id,
          bdr_id: entry.bdr_id,
          deal_id: entry.deal_id,
          amount: Number(entry.amount),
          status: entry.status,
          payable_date: entry.payable_date,
          accrual_date: entry.accrual_date,
          month: entry.month,
        };
        const approvalSource = getEntryApprovalSource(entryForApproval, approvalSets);
        const isApproved = approvalSource !== null;
        const reportAdj = includeReportAdjustments ? adjustmentByEntryId.get(entry.id) : undefined;
        return {
          ...entry,
          is_approved: isApproved,
          approval_label: formatApprovalSourceLabel(approvalSource),
          ...(reportAdj ? { report_adjustment: reportAdj } : {}),
          is_renewal: isRenewal,
          deals: entry.deals_client_name ? {
            client_name: entry.deals_client_name,
            service_type: entry.deals_service_type,
          } : null,
          bdr_reps: entry.bdr_reps_name ? {
            name: entry.bdr_reps_name,
            email: entry.bdr_reps_email,
          } : null,
          payment_sequence: lookupPaymentSequence(
            paymentSeqMap,
            entry.revenue_events_id ?? null,
            entry.id
          ).label,
          revenue_events: entry.revenue_events_id ? {
            id: entry.revenue_events_id,
            service_id: entry.revenue_events_service_id,
            amount_collected: entry.revenue_events_amount_collected,
            collection_date: entry.revenue_events_collection_date,
            billing_type: entry.revenue_events_billing_type,
            payment_stage: entry.revenue_events_payment_stage,
            service_name: entry.deal_services_service_name,
            payment_sequence: lookupPaymentSequence(
              paymentSeqMap,
              entry.revenue_events_id ?? null,
              entry.id
            ).label,
          } : null,
        };
      });

      return apiSuccess({
        data: entriesWithRelations,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      }, 200, { cache: 'no-store' }); // No cache to ensure fresh data
    }

    // Supabase mode - exclude entries from cancelled deals
    const supabase = await createClient();

    // Build query - use type assertion to avoid TypeScript inference issues
    // Exclude entries from cancelled deals by joining and filtering
    // Include deal_services to get service_name for each commission entry
    const baseQuery: any = (supabase as any)
      .from('commission_entries')
      .select('*, deals!inner(client_name, service_type, is_renewal, cancellation_date), bdr_reps(name, email), revenue_events(deal_services(service_name, is_renewal), *)')
      .is('deals.cancellation_date', null)
      .order('accrual_date', { ascending: false, nullsFirst: false })
      .order('month', { ascending: false });

    // If not admin, only show own entries
    let query = baseQuery;
    if (!isUserAdmin) {
      const { getBdrIdFromUser } = await import('@/lib/utils/auth');
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      query = query.eq('bdr_id', userBdrId);
    } else if (bdrId) {
      query = query.eq('bdr_id', bdrId);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (month) {
      query = query.eq('month', month);
    }

    if (payableMonth) {
      // Filter by payable month (payable_date first, then accrual_date, then month)
      query = query.or(`payable_date.like.${payableMonth}%,accrual_date.like.${payableMonth}%,month.like.${payableMonth}%`);
    }

    // Add pagination
    query = query.range(offset, offset + limit - 1);

    // Execute query with explicit type casting
    const { data, error, count } = (await query) as { data: any[] | null; error: any; count?: number };

    if (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Commission entries API error:', error);
      }
      return apiError(error.message || 'Failed to fetch commission entries', 500);
    }

    const { data: approvedBatches } = await supabase.from('commission_batches').select('id').in('status', ['approved', 'paid']);
    const approvedBatchIds = (approvedBatches || []).map((b: { id: string }) => b.id);
    let approvedEntryIdsSupa = new Set<string>();
    if (approvedBatchIds.length > 0) {
      const { data: batchItems } = await supabase
        .from('commission_batch_items')
        .select('commission_entry_id')
        .in('batch_id', approvedBatchIds);
      approvedEntryIdsSupa = new Set((batchItems || []).map((r: { commission_entry_id: string }) => r.commission_entry_id));
    }
    let adjustmentByEntryIdSupa = new Map<string, import('@/lib/commission/export-rows').ReportAdjustmentMeta>();
    if (includeReportAdjustments) {
      const { mergeSnapshotsIntoAdjustmentMap } = await import('@/lib/commission/export-rows');
      const { data: snaps } = await supabase.from('commission_batch_snapshots').select('batch_id, snapshot_data');
      for (const s of snaps || []) {
        let rowsParsed: unknown = (s as { snapshot_data: unknown }).snapshot_data;
        if (typeof rowsParsed === 'string') {
          try {
            rowsParsed = JSON.parse(rowsParsed);
          } catch {
            continue;
          }
        }
        mergeSnapshotsIntoAdjustmentMap(rowsParsed, (s as { batch_id: string }).batch_id, adjustmentByEntryIdSupa);
      }
    }

    const { data: fpsSupa } = await supabase.from('approved_commission_fingerprints').select('bdr_id, deal_id, effective_date');
    const fpSetSupa = new Set(
      (fpsSupa || []).map(
        (f: { bdr_id: string; deal_id: string; effective_date: string }) =>
          `${f.bdr_id}|${f.deal_id}|${normDateStr(f.effective_date) || f.effective_date}`
      )
    );
    const fpMonthSetSupa = new Set(
      (fpsSupa || [])
        .map((f: { bdr_id: string; deal_id: string; effective_date: string }) => {
          const nd = normDateStr(f.effective_date);
          const ym = nd && nd.length >= 7 ? nd.slice(0, 7) : '';
          return ym ? `${f.bdr_id}|${f.deal_id}|${ym}` : '';
        })
        .filter(Boolean)
    );

    // Transform Supabase response to include service_name and is_renewal in revenue_events
    const transformedData = (data || []).map((entry: any) => {
      let result = { ...entry };
      const serviceObj = entry.revenue_events?.deal_services;
      const ds = Array.isArray(serviceObj) ? serviceObj[0] : serviceObj;
      const serviceIsRenewal = ds?.is_renewal === true;
      const dealIsRenewal = entry.deals?.is_renewal === true;
      const isRenewal = serviceIsRenewal || dealIsRenewal;

      if (entry.revenue_events) {
        const serviceName = ds?.service_name;
        result = {
          ...result,
          is_renewal: isRenewal,
          revenue_events: {
            ...entry.revenue_events,
            service_name: serviceName,
            deal_services: undefined, // Remove nested structure
          }
        };
      } else {
        result.is_renewal = isRenewal;
      }

      const effRaw = entry.payable_date || entry.accrual_date || (entry.month ? `${entry.month}-01` : null);
      const eff = normDateStr(effRaw) || effRaw;
      const monthKey =
        eff && typeof eff === 'string' && eff.length >= 7 ? `${entry.bdr_id}|${entry.deal_id}|${eff.slice(0, 7)}` : '';
      result.is_approved =
        entry.status === 'paid' ||
        approvedEntryIdsSupa.has(entry.id) ||
        (!!eff &&
          (fpSetSupa.has(`${entry.bdr_id}|${entry.deal_id}|${eff}`) || (!!monthKey && fpMonthSetSupa.has(monthKey))));

      const reportAdjS = includeReportAdjustments ? adjustmentByEntryIdSupa.get(entry.id) : undefined;
      if (reportAdjS) (result as any).report_adjustment = reportAdjS;

      return result;
    });

    // Get total count if not provided by Supabase
    let total = count;
    if (total === undefined) {
      // Need to get count separately
      const countQuery = query.select('id', { count: 'exact', head: true });
      const { count: totalCount } = (await countQuery) as { count: number | null };
      total = totalCount || transformedData.length;
    }
    
    return apiSuccess({
      data: transformedData,
      pagination: {
        page,
        limit,
        total: total || transformedData.length,
        totalPages: Math.ceil((total || transformedData.length) / limit),
      },
      }, 200, { cache: 'no-store' }); // No cache to ensure fresh data
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission entries API exception:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}



