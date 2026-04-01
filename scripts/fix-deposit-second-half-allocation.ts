/**
 * Fix commission allocation for deposit services - second 50% now has 7-day delay.
 * Reprocesses all deals that have at least one deposit service with completion_date
 * so second 50% commission entries get payable_date = completion_date + 7 days.
 *
 * Run: npx tsx scripts/fix-deposit-second-half-allocation.ts
 * Requires: USE_LOCAL_DB=true (or unset NEXT_PUBLIC_SUPABASE_URL)
 */

import { getLocalDB } from '../lib/db/local-db';
import {
  createRevenueEventsForDeal,
  processRevenueEvent,
} from '../lib/commission/revenue-events-local';

const USE_LOCAL_DB =
  process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function fixDepositSecondHalfAllocation() {
  if (!USE_LOCAL_DB) {
    console.error(
      'This script only works with local database. Set USE_LOCAL_DB=true or use the API: POST /api/deals/reprocess-deposit-second-half'
    );
    process.exit(1);
  }

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
    console.log('No deals with deposit services (second 50%) found.');
    process.exit(0);
  }

  console.log(
    `Found ${dealIds.length} deal(s) with deposit second 50%. Reprocessing...\n`
  );

  let success = 0;
  let errors = 0;

  for (const { id: dealId, client_name } of dealIds) {
    try {
      console.log(`  Processing: ${client_name} (${dealId})`);

      db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(dealId);
      db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);

      await createRevenueEventsForDeal(dealId);

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
  console.log('\n✓ Deposit second 50% allocation fix complete.');
}

fixDepositSecondHalfAllocation()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
