import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { createRevenueEventsForDeal, processRevenueEvent } from '@/lib/commission/revenue-events';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Reprocess a deal to create revenue events and commission entries
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    const body = await request.json();
    const { dealId } = body;

    if (!dealId) {
      return apiError('Deal ID is required', 400);
    }

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Check if deal exists
      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
      if (!deal) {
        return apiError('Deal not found', 404);
      }

      // Create revenue events for the deal
      await createRevenueEventsForDeal(dealId);

      // Process all revenue events to create commission entries
      const revenueEvents = db.prepare(`
        SELECT id FROM revenue_events WHERE deal_id = ?
      `).all(dealId) as Array<{ id: string }>;

      for (const event of revenueEvents) {
        try {
          await processRevenueEvent(event.id);
        } catch (error) {
          console.error(`Error processing revenue event ${event.id}:`, error);
        }
      }

      return apiSuccess({ message: 'Deal reprocessed successfully', eventsProcessed: revenueEvents.length });
    }

    // Supabase mode
    const supabase = await createClient();

    // Check if deal exists
    const { data: deal, error: dealError } = await (supabase
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .single() as any);

    if (dealError || !deal) {
      return apiError('Deal not found', 404);
    }

    // Create revenue events for the deal
    await createRevenueEventsForDeal(dealId);

    // Process all revenue events
    const { data: revenueEvents } = await (supabase
      .from('revenue_events')
      .select('id')
      .eq('deal_id', dealId) as any);

    if (revenueEvents) {
      for (const event of revenueEvents) {
        try {
          await processRevenueEvent(event.id);
        } catch (error) {
          console.error(`Error processing revenue event ${event.id}:`, error);
        }
      }
    }

    return apiSuccess({ 
      message: 'Deal reprocessed successfully', 
      eventsProcessed: revenueEvents?.length || 0 
    });
  } catch (error: any) {
    return apiError(error.message, 500);
  }
}

