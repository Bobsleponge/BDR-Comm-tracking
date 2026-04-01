import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { createRevenueEventsForDeal, processRevenueEvent } from '@/lib/commission/revenue-events';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Reprocess all deals with deposit services (completion_date) to apply 7-day delay for second 50%.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const dealIds = db
        .prepare(
          `
          SELECT DISTINCT d.id, d.client_name
          FROM deals d
          INNER JOIN deal_services ds ON ds.deal_id = d.id
          WHERE ds.billing_type = 'deposit'
            AND ds.completion_date IS NOT NULL
            AND d.cancellation_date IS NULL
          ORDER BY d.client_name
        `
        )
        .all() as Array<{ id: string; client_name: string }>;

      if (dealIds.length === 0) {
        return apiSuccess({
          message: 'No deals with deposit second 50% found.',
          processed: 0,
          errors: 0,
          total: 0,
          dealIds: [],
        });
      }

      let processed = 0;
      let errors = 0;

      for (const { id: dealId } of dealIds) {
        try {
          db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(dealId);
          db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);

          await createRevenueEventsForDeal(dealId);

          const events = db
            .prepare('SELECT id FROM revenue_events WHERE deal_id = ?')
            .all(dealId) as Array<{ id: string }>;

          for (const ev of events) {
            try {
              await processRevenueEvent(ev.id);
            } catch {
              // Continue
            }
          }
          processed++;
        } catch {
          errors++;
        }
      }

      return apiSuccess({
        message: `Reprocessed ${processed} deal(s) with deposit second 50%. ${errors} errors.`,
        processed,
        errors,
        total: dealIds.length,
        dealIds: dealIds.map((d) => d.id),
      });
    }

    // Supabase
    const supabase = (await createClient()) as any;

    const { data: servicesWithDeposit, error: svcError } = await supabase
      .from('deal_services')
      .select('deal_id')
      .eq('billing_type', 'deposit')
      .not('completion_date', 'is', null);

    if (svcError) {
      return apiError('Failed to fetch deposit services', 500);
    }

    const uniqueDealIds = [...new Set((servicesWithDeposit || []).map((r: any) => r.deal_id))];

    if (uniqueDealIds.length === 0) {
      return apiSuccess({
        message: 'No deals with deposit second 50% found.',
        processed: 0,
        errors: 0,
        total: 0,
        dealIds: [],
      });
    }

    const { data: deals, error: dealsError } = await supabase
      .from('deals')
      .select('id')
      .in('id', uniqueDealIds)
      .is('cancellation_date', null);

    if (dealsError) {
      return apiError('Failed to fetch deals', 500);
    }

    const dealIds = (deals || []).map((d: any) => d.id);
    let processed = 0;
    let errors = 0;

    for (const dealId of dealIds) {
      try {
        await supabase.from('commission_entries').delete().eq('deal_id', dealId);
        await supabase.from('revenue_events').delete().eq('deal_id', dealId);

        await createRevenueEventsForDeal(dealId);

        const { data: events } = await supabase
          .from('revenue_events')
          .select('id')
          .eq('deal_id', dealId);

        for (const ev of events || []) {
          try {
            await processRevenueEvent(ev.id);
          } catch {
            // Continue
          }
        }
        processed++;
      } catch {
        errors++;
      }
    }

    return apiSuccess({
      message: `Reprocessed ${processed} deal(s) with deposit second 50%. ${errors} errors.`,
      processed,
      errors,
      total: dealIds.length,
      dealIds,
    });
  } catch (error: any) {
    return apiError(error.message, 500);
  }
}
