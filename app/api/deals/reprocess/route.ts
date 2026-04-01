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

      // Do not reprocess if any commission entries are in approved/paid batches (prevents duplicate commissions)
      const inApprovedBatch = db.prepare(`
        SELECT 1 FROM commission_entries ce
        JOIN commission_batch_items cbi ON cbi.commission_entry_id = ce.id
        JOIN commission_batches cb ON cbi.batch_id = cb.id
        WHERE ce.deal_id = ? AND cb.status IN ('approved', 'paid')
        LIMIT 1
      `).get(dealId) as { '1': number } | undefined;
      if (inApprovedBatch) {
        return apiError('Deal has entries in an approved/paid report; reprocessing would create duplicates', 400);
      }

      // Delete existing revenue events and commission entries (prevents duplicates)
      db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(dealId);
      db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);

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
    const supabase = await createClient() as any;

    // Check if deal exists
    const dealResult = await supabase
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .single();
    
    const deal = dealResult.data;
    const dealError = dealResult.error;

    if (dealError || !deal) {
      return apiError('Deal not found', 404);
    }

    // Do not reprocess if any commission entries are in approved/paid batches
    const { data: dealEntries } = await (supabase as any).from('commission_entries').select('id').eq('deal_id', dealId);
    if (dealEntries?.length) {
      const entryIds = dealEntries.map((e: any) => e.id);
      const { data: cbiRows } = await (supabase as any).from('commission_batch_items').select('batch_id').in('commission_entry_id', entryIds);
      const batchIds = [...new Set((cbiRows || []).map((r: any) => r.batch_id))];
      if (batchIds.length > 0) {
        const { data: batchStatuses } = await (supabase as any).from('commission_batches').select('status').in('id', batchIds);
        const hasApproved = (batchStatuses || []).some((b: any) => ['approved', 'paid'].includes(b.status));
        if (hasApproved) {
          return apiError('Deal has entries in an approved/paid report; reprocessing would create duplicates', 400);
        }
      }
    }

    // Delete existing revenue events and commission entries (prevents duplicates)
    await (supabase as any).from('commission_entries').delete().eq('deal_id', dealId);
    await (supabase as any).from('revenue_events').delete().eq('deal_id', dealId);

    // Create revenue events for the deal
    await createRevenueEventsForDeal(dealId);

    // Process all revenue events
    const eventsResult = await supabase
      .from('revenue_events')
      .select('id')
      .eq('deal_id', dealId);

    const revenueEvents = eventsResult.data || [];

    for (const event of revenueEvents) {
      try {
        await processRevenueEvent(event.id);
      } catch (error) {
        console.error(`Error processing revenue event ${event.id}:`, error);
      }
    }

    return apiSuccess({ 
      message: 'Deal reprocessed successfully', 
      eventsProcessed: revenueEvents.length 
    });
  } catch (error: any) {
    return apiError(error.message, 500);
  }
}



