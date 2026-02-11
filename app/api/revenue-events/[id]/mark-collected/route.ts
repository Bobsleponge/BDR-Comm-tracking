import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { processRevenueEvent } from '@/lib/commission/revenue-events';
import { format } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    await requireAdmin();

    const { id } = await params;
    const body = await request.json();
    const { collection_date } = body;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Get revenue event
      const event = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(id) as any;
      if (!event) {
        return apiError('Revenue event not found', 404);
      }

      // Update collection date if provided
      if (collection_date) {
        db.prepare(`
          UPDATE revenue_events 
          SET collection_date = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(collection_date, id);
      }

      // Process the revenue event to create commission entry
      const commissionEntryId = await processRevenueEvent(id);

      return apiSuccess({
        revenue_event_id: id,
        commission_entry_id: commissionEntryId,
        message: commissionEntryId
          ? 'Revenue event marked as collected and commission entry created'
          : 'Revenue event marked as collected (no commission entry created - may not be commissionable or BDR not eligible)',
      });
    }

    // Supabase mode
    const supabase = await createClient() as any;

    // Get revenue event
    const { data: event, error: eventError } = await (supabase
      .from('revenue_events')
      .select('*')
      .eq('id', id)
      .single() as any);

    if (eventError || !event) {
      return apiError('Revenue event not found', 404);
    }

    // Update collection date if provided
    if (collection_date) {
      await (supabase
        .from('revenue_events')
        .update({ collection_date, updated_at: new Date().toISOString() })
        .eq('id', id) as any);
    }

    // Process the revenue event
    const commissionEntryId = await processRevenueEvent(id);

    return apiSuccess({
      revenue_event_id: id,
      commission_entry_id: commissionEntryId,
      message: commissionEntryId
        ? 'Revenue event marked as collected and commission entry created'
        : 'Revenue event marked as collected (no commission entry created - may not be commissionable or BDR not eligible)',
    });
  } catch (error: any) {
    return apiError(error.message || 'Failed to mark revenue event as collected', 500);
  }
}



