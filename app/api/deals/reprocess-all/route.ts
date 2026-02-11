import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { createRevenueEventsForDeal, processRevenueEvent } from '@/lib/commission/revenue-events';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Reprocess closed-won deals in the background.
 * Optional query params: close_month (YYYY-MM) - only process deals closed in that month
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    const { searchParams } = new URL(request.url);
    const closeMonth = searchParams.get('close_month'); // e.g. "2025-12"

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      let deals: Array<{ id: string }>;
      if (closeMonth && /^\d{4}-\d{2}$/.test(closeMonth)) {
        const [year, month] = closeMonth.split('-');
        const startDate = `${year}-${month}-01`;
        const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
        const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
        deals = db.prepare(`
          SELECT id FROM deals 
          WHERE status = 'closed-won' AND first_invoice_date IS NOT NULL
            AND close_date >= ? AND close_date <= ?
        `).all(startDate, endDate) as Array<{ id: string }>;
      } else {
        deals = db.prepare(`
          SELECT id FROM deals 
          WHERE status = 'closed-won' AND first_invoice_date IS NOT NULL
        `).all() as Array<{ id: string }>;
      }

      let processed = 0;
      let errors = 0;

      // Process deals in batches to avoid blocking
      const batchSize = 5;
      for (let i = 0; i < deals.length; i += batchSize) {
        const batch = deals.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (deal) => {
          try {
            // Clear existing revenue events and commission entries for this deal (prevents duplicates)
            db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(deal.id);
            db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(deal.id);

            // Create revenue events
            await createRevenueEventsForDeal(deal.id);

            // Process ALL revenue events (including future/scheduled) - commission entries are created for the appropriate month based on the scheduled date
            const revenueEvents = db.prepare(`
              SELECT id FROM revenue_events 
              WHERE deal_id = ?
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
    const supabase = await createClient() as any;

    let query: any = supabase
      .from('deals')
      .select('id, first_invoice_date, close_date')
      .eq('status', 'closed-won');

    if (closeMonth && /^\d{4}-\d{2}$/.test(closeMonth)) {
      const [year, month] = closeMonth.split('-');
      const startDate = `${year}-${month}-01`;
      const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
      const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
      query = query.gte('close_date', startDate).lte('close_date', endDate);
    }

    const { data: allDeals, error: dealsError } = await query;
    
    if (dealsError) {
      return apiError('Failed to fetch deals', 500);
    }
    
    // Filter out null first_invoice_date
    const filteredDeals = (allDeals || []).filter((deal: any) => deal.first_invoice_date !== null);

    if (dealsError) {
      return apiError('Failed to fetch deals', 500);
    }

    let processed = 0;
    let errors = 0;

    // Process in batches
    const batchSize = 5;
    for (let i = 0; i < filteredDeals.length; i += batchSize) {
      const batch = filteredDeals.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (deal: any) => {
        try {
          await createRevenueEventsForDeal(deal.id);

          const { data: revenueEvents } = await (supabase
            .from('revenue_events')
            .select('id')
            .eq('deal_id', deal.id) as any);

          if (revenueEvents && revenueEvents.length > 0) {
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
      total: filteredDeals.length
    });
  } catch (error: any) {
    return apiError(error.message, 500);
  }
}



