import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { createRevenueEventsForDeal, processRevenueEvent } from '@/lib/commission/revenue-events';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Reprocess all closed-won deals in the background
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Get all closed-won deals
      const deals = db.prepare(`
        SELECT id FROM deals 
        WHERE status = 'closed-won' AND first_invoice_date IS NOT NULL
      `).all() as Array<{ id: string }>;

      let processed = 0;
      let errors = 0;

      // Process deals in batches to avoid blocking
      const batchSize = 5;
      for (let i = 0; i < deals.length; i += batchSize) {
        const batch = deals.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (deal) => {
          try {
            // Create revenue events
            await createRevenueEventsForDeal(deal.id);

            // Process revenue events that are due
            const revenueEvents = db.prepare(`
              SELECT id FROM revenue_events 
              WHERE deal_id = ? AND collection_date <= date('now')
            `).all(deal.id) as Array<{ id: string }>;

            await Promise.all(revenueEvents.map(event => 
              processRevenueEvent(event.id).catch(err => {
                console.error(`Error processing event ${event.id}:`, err);
              })
            ));

            processed++;
          } catch (err) {
            console.error(`Error processing deal ${deal.id}:`, err);
            errors++;
          }
        }));
      }

      return apiSuccess({ 
        message: `Reprocessing complete: ${processed} deals processed, ${errors} errors`,
        processed,
        errors,
        total: deals.length
      });
    }

    // Supabase mode
    const supabase = await createClient();

    const { data: deals, error: dealsError } = await (supabase
      .from('deals')
      .select('id')
      .eq('status', 'closed-won')
      .not('first_invoice_date', 'is', null) as any);

    if (dealsError) {
      return apiError('Failed to fetch deals', 500);
    }

    let processed = 0;
    let errors = 0;

    // Process in batches
    const batchSize = 5;
    for (let i = 0; i < (deals || []).length; i += batchSize) {
      const batch = (deals || []).slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (deal: any) => {
        try {
          await createRevenueEventsForDeal(deal.id);

          const today = new Date().toISOString().split('T')[0];
          const { data: revenueEvents } = await (supabase
            .from('revenue_events')
            .select('id')
            .eq('deal_id', deal.id)
            .lte('collection_date', today) as any);

          if (revenueEvents) {
            await Promise.all(revenueEvents.map((event: any) =>
              processRevenueEvent(event.id).catch(err => {
                console.error(`Error processing event ${event.id}:`, err);
              })
            ));
          }

          processed++;
        } catch (err) {
          console.error(`Error processing deal ${deal.id}:`, err);
          errors++;
        }
      }));
    }

    return apiSuccess({ 
      message: `Reprocessing complete: ${processed} deals processed, ${errors} errors`,
      processed,
      errors,
      total: (deals || []).length
    });
  } catch (error: any) {
    return apiError(error.message, 500);
  }
}

