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

      // Get commission rules for payout delay
      const rules = db.prepare('SELECT payout_delay_days, base_rate FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
      const payoutDelayDays = rules?.payout_delay_days || 30;
      const baseRate = rules?.base_rate || 0.025;

      // Build query to get commission entries with all related data
      // Also include scheduled revenue events that will become payable (for recurring services)
      const params: any[] = [];
      
      // Build first part: existing commission entries
      let query1 = `
        SELECT 
          ce.id,
          ce.amount,
          ce.status,
          ce.accrual_date,
          ce.payable_date,
          ce.month,
          d.id as deal_id,
          d.client_name,
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
        query1 += ' AND ce.bdr_id = ?';
        params.push(targetBdrId);
      }

      if (serviceType) {
        query1 += ' AND d.service_type = ?';
        params.push(serviceType);
      }

      if (billingType) {
        query1 += ' AND (ds.billing_type = ? OR re.billing_type = ?)';
        params.push(billingType, billingType);
      }

      // Since all revenue events are now processed immediately, we don't need the UNION query
      // All events should have commission entries, so we only query commission_entries
      // This significantly improves performance by removing the complex UNION
      // Order by accrual_date first (when earned) so months are grouped correctly
      // Limit to prevent huge result sets
      const query = `${query1} ORDER BY accrual_date ASC, payable_date ASC LIMIT 5000`;

      const entries = db.prepare(query).all(...params) as any[];

      // Group by payable month
      const breakdownByMonth = new Map<string, {
        month: string;
        totalAmount: number;
        entries: any[];
      }>();

      entries.forEach(entry => {
        // Use accrual_date first (when commission is earned), fallback to month, then payable_date
        const accrualMonth = entry.accrual_date
          ? entry.accrual_date.substring(0, 7) // YYYY-MM format
          : entry.month 
            ? (typeof entry.month === 'string' ? entry.month.substring(0, 7) : entry.month)
            : entry.payable_date?.substring(0, 7) || 'unknown';

        if (!breakdownByMonth.has(accrualMonth)) {
          breakdownByMonth.set(accrualMonth, {
            month: accrualMonth,
            totalAmount: 0,
            entries: [],
          });
        }

        const monthData = breakdownByMonth.get(accrualMonth)!;
        monthData.totalAmount += Number(entry.amount);
        monthData.entries.push({
          id: entry.id,
          amount: Number(entry.amount),
          status: entry.status || (entry.source_type === 'scheduled_revenue' ? 'scheduled' : entry.status),
          accrualDate: entry.accrual_date,
          payableDate: entry.payable_date,
          deal: {
            id: entry.deal_id,
            clientName: entry.client_name,
            serviceType: entry.deal_service_type,
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
      }, 200, { cache: 30 }); // Cache for 30 seconds
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
        deals!inner(id, client_name, service_type, cancellation_date),
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

    // Group by accrual month (when commission is earned) instead of payable month
    // This ensures all months show commission when it was earned, not when it's paid
    const breakdownByMonth = new Map<string, {
      month: string;
      totalAmount: number;
      entries: any[];
    }>();

    filteredEntries.forEach((entry: any) => {
      // Use accrual_date first (when commission is earned), fallback to month, then payable_date
      const accrualMonth = entry.accrual_date
        ? entry.accrual_date.substring(0, 7) // YYYY-MM format
        : entry.month 
          ? (typeof entry.month === 'string' ? entry.month.substring(0, 7) : entry.month)
          : entry.payable_date?.substring(0, 7) || 'unknown';

      if (!breakdownByMonth.has(accrualMonth)) {
        breakdownByMonth.set(accrualMonth, {
          month: accrualMonth,
          totalAmount: 0,
          entries: [],
        });
      }

      const monthData = breakdownByMonth.get(accrualMonth)!;
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
    }, 200, { cache: 30 }); // Cache for 30 seconds
  } catch (error: any) {
    return apiError(error.message || 'Unauthorized', 401);
  }
}

