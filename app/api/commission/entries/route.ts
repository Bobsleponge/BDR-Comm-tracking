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
          br.name as bdr_reps_name,
          br.email as bdr_reps_email,
          re.id as revenue_events_id,
          re.service_id as revenue_events_service_id,
          re.amount_collected as revenue_events_amount_collected,
          re.collection_date as revenue_events_collection_date,
          re.billing_type as revenue_events_billing_type,
          re.payment_stage as revenue_events_payment_stage,
          ds.service_name as deal_services_service_name
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        LEFT JOIN bdr_reps br ON ce.bdr_id = br.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        LEFT JOIN deal_services ds ON re.service_id = ds.id
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
        // Filter by payable_date in the specified month (YYYY-MM format)
        query += ' AND strftime("%Y-%m", ce.payable_date) = ?';
        params.push(payableMonth);
      }

      query += ' ORDER BY COALESCE(ce.payable_date, ce.accrual_date, ce.month) DESC LIMIT 1000';

      const entries = db.prepare(query).all(...params) as any[];

      // Transform results to match expected format (only include essential fields)
      const entriesWithRelations = entries.map(entry => ({
        ...entry,
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
      }));

      return apiSuccess(entriesWithRelations, 200, { cache: 30 }); // Increased cache to 30 seconds
    }

    // Supabase mode - exclude entries from cancelled deals
    const supabase = await createClient();

    // Build query - use type assertion to avoid TypeScript inference issues
    // Exclude entries from cancelled deals by joining and filtering
    // Include deal_services to get service_name for each commission entry
    const baseQuery: any = (supabase as any)
      .from('commission_entries')
      .select('*, deals!inner(client_name, service_type, cancellation_date), bdr_reps(name, email), revenue_events(deal_services(service_name), *)')
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
      // Filter by payable_date in the specified month (YYYY-MM format)
      query = query.like('payable_date', `${payableMonth}%`);
    }

    // Execute query with explicit type casting
    const { data, error } = (await query) as { data: any[] | null; error: any };

    if (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Commission entries API error:', error);
      }
      return apiError(error.message || 'Failed to fetch commission entries', 500);
    }

    // Transform Supabase response to include service_name in revenue_events
    const transformedData = (data || []).map((entry: any) => {
      if (entry.revenue_events && entry.revenue_events.deal_services) {
        // Extract service_name from nested deal_services
        const serviceName = Array.isArray(entry.revenue_events.deal_services) 
          ? entry.revenue_events.deal_services[0]?.service_name 
          : entry.revenue_events.deal_services?.service_name;
        
        return {
          ...entry,
          revenue_events: {
            ...entry.revenue_events,
            service_name: serviceName,
            deal_services: undefined, // Remove nested structure
          }
        };
      }
      return entry;
    });

    return apiSuccess(transformedData, 200, { cache: 10 }); // Cache for 10 seconds
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission entries API exception:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}



