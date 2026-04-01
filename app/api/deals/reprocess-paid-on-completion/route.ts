import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { addDays, format, parseISO } from 'date-fns';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { createRevenueEventsForDeal, processRevenueEvent } from '@/lib/commission/revenue-events';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Reprocess all deals with Paid on Completion services to fix commission allocation.
 * Ensures accrual_date = completion date, payable_date = completion + 7 days,
 * and commission appears in the correct (payable) month.
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
          WHERE ds.billing_type = 'paid_on_completion'
            AND ds.completion_date IS NOT NULL
            AND d.cancellation_date IS NULL
          ORDER BY d.client_name
        `
        )
        .all() as Array<{ id: string; client_name: string }>;

      if (dealIds.length === 0) {
        return apiSuccess({
          message: 'No deals with Paid on Completion services found.',
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
          // Set first_invoice_date = completion_date from paid_on_completion service
          const pocService = db
            .prepare(
              `SELECT completion_date FROM deal_services 
               WHERE deal_id = ? AND billing_type = 'paid_on_completion' AND completion_date IS NOT NULL LIMIT 1`
            )
            .get(dealId) as { completion_date: string } | undefined;
          if (pocService?.completion_date) {
            const dateStr = pocService.completion_date.split('T')[0];
            db.prepare('UPDATE deals SET first_invoice_date = ?, updated_at = datetime(\'now\') WHERE id = ?').run(dateStr, dealId);
          }

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
              // Continue with other events
            }
          }

          // Correct POC entries: use service completion_date (not close_date+7)
          const pocForFix = db.prepare(
            `SELECT completion_date FROM deal_services 
             WHERE deal_id = ? AND billing_type = 'paid_on_completion' AND completion_date IS NOT NULL LIMIT 1`
          ).get(dealId) as { completion_date: string } | undefined;
          if (pocForFix?.completion_date) {
            const completionStr = pocForFix.completion_date.split('T')[0];
            const payableStr = format(addDays(parseISO(completionStr), 7), 'yyyy-MM-dd');
            const revIds = db.prepare(
              `SELECT re.id FROM revenue_events re JOIN deal_services ds ON re.service_id = ds.id
               WHERE re.deal_id = ? AND ds.billing_type = 'paid_on_completion'`
            ).all(dealId) as Array<{ id: string }>;
            for (const r of revIds) {
              db.prepare('UPDATE revenue_events SET collection_date = ? WHERE id = ?').run(completionStr, r.id);
            }
            const entryIds = db.prepare(
              `SELECT ce.id FROM commission_entries ce
               JOIN revenue_events re ON ce.revenue_event_id = re.id
               JOIN deal_services ds ON re.service_id = ds.id
               WHERE ce.deal_id = ? AND ds.billing_type = 'paid_on_completion'`
            ).all(dealId) as Array<{ id: string }>;
            for (const e of entryIds) {
              db.prepare('UPDATE commission_entries SET accrual_date = ?, payable_date = ?, month = ? WHERE id = ?')
                .run(completionStr, payableStr, completionStr, e.id);
            }
          }

          processed++;
        } catch {
          errors++;
        }
      }

      return apiSuccess({
        message: `Reprocessed ${processed} deal(s) with Paid on Completion. ${errors} errors.`,
        processed,
        errors,
        total: dealIds.length,
        dealIds: dealIds.map((d) => d.id),
      });
    }

    // Supabase mode
    const supabase = (await createClient()) as any;

    const { data: servicesWithPOC, error: svcError } = await supabase
      .from('deal_services')
      .select('deal_id')
      .eq('billing_type', 'paid_on_completion')
      .not('completion_date', 'is', null);

    if (svcError) {
      return apiError('Failed to fetch paid on completion services', 500);
    }

    const uniqueDealIds = [...new Set((servicesWithPOC || []).map((r: any) => r.deal_id))];

    if (uniqueDealIds.length === 0) {
      return apiSuccess({
        message: 'No deals with Paid on Completion services found.',
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
        // Set first_invoice_date = completion_date from paid_on_completion service
        const { data: pocService } = await supabase
          .from('deal_services')
          .select('completion_date')
          .eq('deal_id', dealId)
          .eq('billing_type', 'paid_on_completion')
          .not('completion_date', 'is', null)
          .limit(1)
          .maybeSingle();
        if (pocService?.completion_date) {
          const dateStr = typeof pocService.completion_date === 'string'
            ? pocService.completion_date.split('T')[0]
            : pocService.completion_date;
          await supabase.from('deals').update({ first_invoice_date: dateStr }).eq('id', dealId);
        }

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

        // Correct POC entries: use service completion_date (not close_date+7)
        const { data: pocRow } = await supabase
          .from('deal_services')
          .select('id, completion_date')
          .eq('deal_id', dealId)
          .eq('billing_type', 'paid_on_completion')
          .not('completion_date', 'is', null)
          .limit(1)
          .maybeSingle();
        if (pocRow?.completion_date) {
          const completionStr = typeof pocRow.completion_date === 'string'
            ? pocRow.completion_date.split('T')[0]
            : pocRow.completion_date;
          const payableStr = format(addDays(parseISO(completionStr), 7), 'yyyy-MM-dd');
          const { data: revs } = await supabase.from('revenue_events').select('id').eq('deal_id', dealId).eq('service_id', pocRow.id);
          for (const r of revs || []) {
            await supabase.from('revenue_events').update({ collection_date: completionStr }).eq('id', r.id);
          }
          const revIds = (revs || []).map((r: any) => r.id);
          if (revIds.length > 0) {
            const { data: ces } = await supabase.from('commission_entries').select('id').eq('deal_id', dealId).in('revenue_event_id', revIds);
            for (const ce of ces || []) {
              await supabase.from('commission_entries').update({ accrual_date: completionStr, payable_date: payableStr, month: completionStr }).eq('id', ce.id);
            }
          }
        }

        processed++;
      } catch {
        errors++;
      }
    }

    return apiSuccess({
      message: `Reprocessed ${processed} deal(s) with Paid on Completion. ${errors} errors.`,
      processed,
      errors,
      total: dealIds.length,
      dealIds,
    });
  } catch (error: any) {
    return apiError(error.message, 500);
  }
}
