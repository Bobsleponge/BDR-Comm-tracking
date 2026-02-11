import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { addMonths, format, startOfMonth } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');
    const months = parseInt(searchParams.get('months') || '12', 10);

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    // Determine which BDR to query
    let targetBdrId = bdrId;
    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      targetBdrId = userBdrId;
    }

    if (!targetBdrId) {
      return apiError('BDR ID is required', 400);
    }

    if (USE_LOCAL_DB) {
      // Local DB mode - base forecast on scheduled revenue events
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const today = new Date().toISOString().split('T')[0];
      
      // Get scheduled revenue events (not yet collected) and calculate expected commission
      const revenueEvents = db.prepare(`
        SELECT re.collection_date, re.amount_collected, re.billing_type, re.commissionable,
               ds.commission_rate, d.service_type
        FROM revenue_events re
        INNER JOIN deals d ON re.deal_id = d.id
        LEFT JOIN deal_services ds ON re.service_id = ds.id
        WHERE re.bdr_id = ? 
          AND re.collection_date > ?
          AND re.commissionable = 1
          AND d.cancellation_date IS NULL
        ORDER BY re.collection_date ASC
      `).all(targetBdrId, today) as any[];

      // Get commission rules for rate calculation
      const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
      const baseRate = rules?.base_rate || 0.025;

      // Group by month and calculate expected commission
      const forecast: Record<string, number> = {};
      const todayMonth = startOfMonth(new Date());
      
      for (let i = 0; i < months; i++) {
        const monthDate = addMonths(todayMonth, i);
        const monthKey = format(monthDate, 'yyyy-MM-dd');
        forecast[monthKey] = 0;
      }

      // Calculate commission for each revenue event and group by month
      revenueEvents.forEach(event => {
        const collectionDate = new Date(event.collection_date);
        const monthKey = format(startOfMonth(collectionDate), 'yyyy-MM-dd');
        
        if (forecast[monthKey] !== undefined) {
          // Calculate commission rate
          let rate = baseRate;
          if (event.commission_rate) {
            rate = event.commission_rate;
          } else if (event.service_type) {
            const servicePricing = db.prepare('SELECT * FROM service_pricing WHERE service_type = ?').get(event.service_type) as any;
            if (servicePricing?.commission_percent) {
              rate = servicePricing.commission_percent;
            }
          }
          
          const commission = event.amount_collected * rate;
          forecast[monthKey] += Number(commission.toFixed(2));
        }
      });

      // Convert to array format
      const forecastArray = Object.entries(forecast).map(([month, amount]) => ({
        month,
        amount: Number(amount.toFixed(2)),
      }));

      return apiSuccess(forecastArray);
    }

    // Supabase mode - base forecast on scheduled revenue events
    const supabase = await createClient() as any;
    const today = new Date().toISOString().split('T')[0];

    // Get scheduled revenue events and calculate expected commission
    const revenueEventsResult = await supabase
      .from('revenue_events')
      .select('collection_date, amount_collected, billing_type, commissionable, deal_services(commission_rate), deals(service_type, cancellation_date)')
      .eq('bdr_id', targetBdrId)
      .gt('collection_date', today)
      .eq('commissionable', true)
      .is('deals.cancellation_date', null)
      .order('collection_date', { ascending: true });
    
    if (revenueEventsResult.error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Commission forecast API error:', revenueEventsResult.error);
      }
      return apiError('Failed to fetch revenue events for forecast', 500);
    }

    const revenueEvents = revenueEventsResult.data || [];

    // Get commission rules
    const rulesResult = await supabase
      .from('commission_rules')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    
    const rules = rulesResult.data;
    
    const baseRate = rules?.base_rate || 0.025;

    // Group by month
    const forecast: Record<string, number> = {};
    const todayMonth = startOfMonth(new Date());
    
    for (let i = 0; i < months; i++) {
      const monthDate = addMonths(todayMonth, i);
      const monthKey = format(monthDate, 'yyyy-MM-dd');
      forecast[monthKey] = 0;
    }

    // Calculate commission for each revenue event
    revenueEvents.forEach((event: any) => {
      const collectionDate = new Date(event.collection_date);
      const monthKey = format(startOfMonth(collectionDate), 'yyyy-MM-dd');
      
      if (forecast[monthKey] !== undefined) {
        // Calculate commission rate
        let rate = baseRate;
        if (event.deal_services?.commission_rate) {
          rate = event.deal_services.commission_rate;
        } else if (event.deals?.service_type) {
          // Would need to fetch service_pricing, but for now use base rate
          // In production, you might want to join this in the query
          rate = baseRate;
        }
        
        const commission = event.amount_collected * rate;
        forecast[monthKey] += Number(commission.toFixed(2));
      }
    });

    // Convert to array format
    const forecastArray = Object.entries(forecast).map(([month, amount]) => ({
      month,
      amount: Number(amount.toFixed(2)),
    }));

    return apiSuccess(forecastArray);
  } catch (error: any) {
    const errorMessage = error.message || 'Unauthorized';
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission forecast API exception:', errorMessage, error);
    }
    return apiError(errorMessage, 401);
  }
}




