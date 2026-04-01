/**
 * Fix commission allocation for deals with Paid on Completion services.
 * Reprocesses all deals that have at least one deal_service with billing_type = 'paid_on_completion'
 * so commission entries get correct accrual_date (completion date) and payable_date (completion + 7 days).
 *
 * Run: npx tsx scripts/fix-paid-on-completion-allocation.ts
 * Requires: USE_LOCAL_DB=true (or unset NEXT_PUBLIC_SUPABASE_URL)
 */

import { getLocalDB } from '../lib/db/local-db';
import { addDays, format, parseISO } from 'date-fns';
import {
  createRevenueEventsForDeal,
  processRevenueEvent,
} from '../lib/commission/revenue-events-local';

const USE_LOCAL_DB =
  process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function fixPaidOnCompletionAllocation() {
  if (!USE_LOCAL_DB) {
    console.error(
      'This script only works with local database. Set USE_LOCAL_DB=true or use the API endpoint for Supabase: POST /api/deals/reprocess-paid-on-completion'
    );
    process.exit(1);
  }

  const db = getLocalDB();

  // Find all deals that have at least one paid_on_completion service
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
    console.log('No deals with Paid on Completion services found.');
    process.exit(0);
  }

  console.log(
    `Found ${dealIds.length} deal(s) with Paid on Completion. Reprocessing...\n`
  );

  let success = 0;
  let errors = 0;

  for (const { id: dealId, client_name } of dealIds) {
    try {
      console.log(`  Processing: ${client_name} (${dealId})`);

      // Set first_invoice_date = completion_date from paid_on_completion service (scheduled expected completion)
      const pocService = db
        .prepare(
          `SELECT completion_date FROM deal_services 
           WHERE deal_id = ? AND billing_type = 'paid_on_completion' AND completion_date IS NOT NULL 
           LIMIT 1`
        )
        .get(dealId) as { completion_date: string } | undefined;
      if (pocService?.completion_date) {
        const dateStr = pocService.completion_date.split('T')[0];
        db.prepare('UPDATE deals SET first_invoice_date = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
          dateStr,
          dealId
        );
        console.log(`    Set first_invoice_date = ${dateStr}`);
      }

      // Delete existing commission entries and revenue events
      db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(
        dealId
      );
      db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);

      // Recreate revenue events with correct logic
      await createRevenueEventsForDeal(dealId);

      // Process each revenue event to create commission entries
      const events = db
        .prepare('SELECT id FROM revenue_events WHERE deal_id = ?')
        .all(dealId) as Array<{ id: string }>;

      let processed = 0;
      for (const ev of events) {
        try {
          await processRevenueEvent(ev.id);
          processed++;
        } catch (err: any) {
          console.error(`    Error processing event ${ev.id}:`, err.message);
        }
      }

      // Correct any POC entries that still have wrong dates (e.g. from close_date+7)
      const pocForFix = db
        .prepare(
          `SELECT completion_date FROM deal_services 
           WHERE deal_id = ? AND billing_type = 'paid_on_completion' AND completion_date IS NOT NULL LIMIT 1`
        )
        .get(dealId) as { completion_date: string } | undefined;
      if (pocForFix?.completion_date) {
        const completionStr = pocForFix.completion_date.split('T')[0];
        const payableStr = format(addDays(parseISO(completionStr), 7), 'yyyy-MM-dd');
        const eventsToFix = db
          .prepare(
            `SELECT re.id FROM revenue_events re
             JOIN deal_services ds ON re.service_id = ds.id
             WHERE re.deal_id = ? AND ds.billing_type = 'paid_on_completion'`
          )
          .all(dealId) as Array<{ id: string }>;
        for (const ev of eventsToFix) {
          db.prepare('UPDATE revenue_events SET collection_date = ? WHERE id = ?').run(completionStr, ev.id);
        }
        const entriesToFix = db
          .prepare(
            `SELECT ce.id FROM commission_entries ce
             JOIN revenue_events re ON ce.revenue_event_id = re.id
             JOIN deal_services ds ON re.service_id = ds.id
             WHERE ce.deal_id = ? AND ds.billing_type = 'paid_on_completion'`
          )
          .all(dealId) as Array<{ id: string }>;
        for (const ent of entriesToFix) {
          db.prepare(
            'UPDATE commission_entries SET accrual_date = ?, payable_date = ?, month = ? WHERE id = ?'
          ).run(completionStr, payableStr, completionStr, ent.id);
        }
        if (entriesToFix.length > 0) {
          console.log(`    Corrected dates to accrual=${completionStr}, payable=${payableStr}`);
        }
      }

      console.log(`    ✓ Created ${processed} commission entries`);
      success++;
    } catch (err: any) {
      console.error(`  ✗ Error:`, err.message);
      errors++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Deals processed: ${success}`);
  console.log(`Errors: ${errors}`);
  console.log('\n✓ Paid on Completion allocation fix complete.');
}

fixPaidOnCompletionAllocation()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
