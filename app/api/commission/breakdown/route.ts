import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Get commission breakdown by month with deal/service details
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');
    const serviceType = searchParams.get('service_type');
    const billingType = searchParams.get('billing_type');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Determine which BDR to query
      let targetBdrId = bdrId;
      if (!isUserAdmin) {
        const userBdrId = await getBdrIdFromUser();
        if (!userBdrId) {
          return apiError('BDR profile not found', 404);
        }
        targetBdrId = userBdrId;
      }

      // Build query to get commission entries with all related data
      // Only show actual commission entries - no forecasted/scheduled payments
      const params: any[] = [];
      
      let query = `
        SELECT 
          ce.id,
          ce.revenue_event_id as revenue_event_id,
          ce.amount,
          ce.status,
          ce.accrual_date,
          ce.payable_date,
          ce.month,
          d.id as deal_id,
          d.client_name,
          d.close_date,
          d.service_type as deal_service_type,
          ds.id as service_id,
          ds.service_name,
          ds.billing_type,
          re.amount_collected,
          re.collection_date,
          re.payment_stage,
          re.billing_type as revenue_billing_type,
          'commission_entry' as source_type
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        LEFT JOIN deal_services ds ON re.service_id = ds.id
        WHERE d.cancellation_date IS NULL
          AND ce.status != 'cancelled'
      `;

      if (targetBdrId) {
        query += ' AND ce.bdr_id = ?';
        params.push(targetBdrId);
      }

      if (serviceType) {
        query += ' AND d.service_type = ?';
        params.push(serviceType);
      }

      if (billingType) {
        query += ' AND (ds.billing_type = ? OR re.billing_type = ?)';
        params.push(billingType, billingType);
      }

      query += ` ORDER BY accrual_date ASC, payable_date ASC LIMIT 5000`;

      const entries = db.prepare(query).all(...params) as any[];

      // Group by payable month (when BDR can claim commission)
      const breakdownByMonth = new Map<string, {
        month: string;
        totalAmount: number;
        entries: any[];
      }>();

      entries.forEach(entry => {
        // Use payable_date first (when BDR can claim commission), fallback to accrual_date, then month
        const payableMonth = entry.payable_date
          ? entry.payable_date.substring(0, 7) // YYYY-MM format
          : entry.accrual_date
            ? entry.accrual_date.substring(0, 7)
            : entry.month 
              ? (typeof entry.month === 'string' ? entry.month.substring(0, 7) : entry.month)
              : 'unknown';

        if (!breakdownByMonth.has(payableMonth)) {
          breakdownByMonth.set(payableMonth, {
            month: payableMonth,
            totalAmount: 0,
            entries: [],
          });
        }

        const monthData = breakdownByMonth.get(payableMonth)!;
        monthData.totalAmount += Number(entry.amount);
        // Generate unique ID: use commission entry ID if available, otherwise use revenue_event_id for scheduled entries
        const uniqueId = entry.id || (entry.revenue_event_id ? `scheduled-${entry.revenue_event_id}` : `scheduled-${entry.deal_id}-${entry.collection_date}`);
        monthData.entries.push({
          id: uniqueId,
          amount: Number(entry.amount),
          status: entry.status || (entry.source_type === 'scheduled_revenue' ? 'scheduled' : entry.status),
          accrualDate: entry.accrual_date,
          payableDate: entry.payable_date,
          deal: {
            id: entry.deal_id,
            clientName: entry.client_name,
            serviceType: entry.deal_service_type,
            closeDate: entry.close_date || null,
          },
          service: entry.service_id ? {
            id: entry.service_id,
            name: entry.service_name,
            billingType: entry.billing_type,
          } : null,
          revenueEvent: entry.amount_collected ? {
            amountCollected: Number(entry.amount_collected),
            collectionDate: entry.collection_date,
            paymentStage: entry.payment_stage,
            billingType: entry.revenue_billing_type || entry.billing_type,
          } : null,
        });
      });

      // Convert to array and sort by month
      const breakdown = Array.from(breakdownByMonth.values())
        .sort((a, b) => a.month.localeCompare(b.month));

      return apiSuccess({
        breakdown,
        total: entries.reduce((sum, e) => sum + Number(e.amount), 0),
        entryCount: entries.length,
      }, 200, { cache: 'no-store' }); // No cache to ensure fresh data
    }

    // Supabase mode
    const supabase = await createClient();

    // Determine which BDR to query
    let targetBdrId = bdrId;
    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      targetBdrId = userBdrId;
    }

    // Build query
    let query: any = (supabase as any)
      .from('commission_entries')
      .select(`
        id,
        amount,
        status,
        accrual_date,
        payable_date,
        month,
        deals!inner(id, client_name, service_type, close_date, cancellation_date),
        revenue_events(
          id,
          amount_collected,
          collection_date,
          payment_stage,
          billing_type,
          deal_services(id, service_name, billing_type)
        )
      `)
      .is('deals.cancellation_date', null)
      .neq('status', 'cancelled')
      .order('accrual_date', { ascending: true, nullsFirst: false })
      .order('payable_date', { ascending: true, nullsFirst: false });

    if (targetBdrId) {
      query = query.eq('bdr_id', targetBdrId);
    }

    if (serviceType) {
      query = query.eq('deals.service_type', serviceType);
    }

    const { data: entries, error } = (await query) as { data: any[] | null; error: any };

    if (error) {
      return apiError(error.message || 'Failed to fetch commission breakdown', 500);
    }

    // Filter by billing type if specified
    let filteredEntries = entries || [];
    if (billingType) {
      filteredEntries = filteredEntries.filter((entry: any) => {
        const revenueEvent = entry.revenue_events;
        if (revenueEvent) {
          return revenueEvent.billing_type === billingType || 
                 revenueEvent.deal_services?.billing_type === billingType;
        }
        return false;
      });
    }

    // Group by payable month (when BDR can claim commission)
    // This ensures commission appears in the month the BDR can actually claim it
    const breakdownByMonth = new Map<string, {
      month: string;
      totalAmount: number;
      entries: any[];
    }>();

    filteredEntries.forEach((entry: any) => {
      // Use payable_date first (when BDR can claim commission), fallback to accrual_date, then month
      const payableMonth = entry.payable_date
        ? entry.payable_date.substring(0, 7) // YYYY-MM format
        : entry.accrual_date
          ? entry.accrual_date.substring(0, 7)
          : entry.month 
            ? (typeof entry.month === 'string' ? entry.month.substring(0, 7) : entry.month)
            : 'unknown';

      if (!breakdownByMonth.has(payableMonth)) {
        breakdownByMonth.set(payableMonth, {
          month: payableMonth,
          totalAmount: 0,
          entries: [],
        });
      }

      const monthData = breakdownByMonth.get(payableMonth)!;
      monthData.totalAmount += Number(entry.amount);
      
      const revenueEvent = entry.revenue_events;
      monthData.entries.push({
        id: entry.id,
        amount: Number(entry.amount),
        status: entry.status,
        accrualDate: entry.accrual_date,
        payableDate: entry.payable_date,
        deal: {
          id: entry.deals.id,
          clientName: entry.deals.client_name,
          serviceType: entry.deals.service_type,
          closeDate: entry.deals.close_date || null,
        },
        service: revenueEvent?.deal_services ? {
          id: revenueEvent.deal_services.id,
          name: revenueEvent.deal_services.service_name,
          billingType: revenueEvent.deal_services.billing_type,
        } : null,
        revenueEvent: revenueEvent ? {
          amountCollected: Number(revenueEvent.amount_collected),
          collectionDate: revenueEvent.collection_date,
          paymentStage: revenueEvent.payment_stage,
          billingType: revenueEvent.billing_type,
        } : null,
      });
    });

    // Convert to array and sort by month
    const breakdown = Array.from(breakdownByMonth.values())
      .sort((a, b) => a.month.localeCompare(b.month));

    return apiSuccess({
      breakdown,
      total: filteredEntries.reduce((sum: number, e: any) => sum + Number(e.amount), 0),
      entryCount: filteredEntries.length,
    }, 200, { cache: 'no-store' }); // No cache to ensure fresh data
  } catch (error: any) {
    return apiError(error.message || 'Unauthorized', 401);
  }
}

