import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');
    const status = searchParams.get('status');
    const month = searchParams.get('month');
    const payableMonth = searchParams.get('payable_month'); // Format: YYYY-MM
    
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

      // Determine which entries are approved (in paid reports via fingerprints)
      const fingerprints = db.prepare('SELECT bdr_id, deal_id, effective_date FROM approved_commission_fingerprints').all() as Array<{ bdr_id: string; deal_id: string; effective_date: string }>;
      const fpSet = new Set(fingerprints.map(f => `${f.bdr_id}|${f.deal_id}|${f.effective_date}`));
      const getEffectiveDate = (e: any) => e.payable_date || e.accrual_date || (e.month ? `${e.month}-01` : null);
      
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
        const effectiveDate = getEffectiveDate(entry);
        const isApproved = effectiveDate && fpSet.has(`${entry.bdr_id}|${entry.deal_id}|${effectiveDate}`);
        return {
          ...entry,
          is_approved: isApproved,
          is_renewal: isRenewal,
          deals: entry.deals_client_name ? {
            client_name: entry.deals_client_name,
            service_type: entry.deals_service_type,
          } : null,
          bdr_reps: entry.bdr_reps_name ? {
            name: entry.bdr_reps_name,
            email: entry.bdr_reps_email,
          } : null,
          revenue_events: entry.revenue_events_id ? {
            id: entry.revenue_events_id,
            service_id: entry.revenue_events_service_id,
            amount_collected: entry.revenue_events_amount_collected,
            collection_date: entry.revenue_events_collection_date,
            billing_type: entry.revenue_events_billing_type,
            payment_stage: entry.revenue_events_payment_stage,
            service_name: entry.deal_services_service_name,
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



