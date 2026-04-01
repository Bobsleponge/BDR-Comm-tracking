/**
 * Recreate commission entries for deals closed in a specific month.
 * Deletes existing revenue_events and commission_entries for those deals,
 * then creates fresh revenue events and commission entries.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/recreate-comm-entries-by-month.ts YYYY-MM
 *
 * Example (Dec 2025):
 *   npx tsx scripts/recreate-comm-entries-by-month.ts 2025-12
 */

import { getLocalDB } from '../lib/db/local-db';
import { createRevenueEventsForDeal, processRevenueEvent } from '../lib/commission/revenue-events-local';

const USE_LOCAL_DB =
  process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function main() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database (USE_LOCAL_DB=true)');
    process.exit(1);
  }

  const monthArg = process.argv[2] || '2025-12';
  const match = monthArg.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    console.error('Usage: npx tsx scripts/recreate-comm-entries-by-month.ts YYYY-MM');
    console.error('Example: npx tsx scripts/recreate-comm-entries-by-month.ts 2025-12');
    process.exit(1);
  }

  const [, year, month] = match;
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;

  const db = getLocalDB();

  const deals = db.prepare(`
    SELECT id, client_name, close_date, status
    FROM deals
    WHERE status = 'closed-won'
      AND cancellation_date IS NULL
      AND close_date >= ?
      AND close_date <= ?
    ORDER BY close_date
  `).all(startDate, endDate) as Array<{ id: string; client_name: string; close_date: string; status: string }>;

  if (deals.length === 0) {
    console.log(`\nNo closed-won deals found for ${monthArg}. Nothing to do.\n`);
    process.exit(0);
  }

  console.log(`\n=== Recreate Commission Entries: ${monthArg} ===\n`);
  console.log(`Found ${deals.length} closed-won deals (close_date between ${startDate} and ${endDate})\n`);

  let totalEvents = 0;
  let totalEntries = 0;
  let errors = 0;

  for (const deal of deals) {
    try {
      // Delete existing revenue events and commission entries for this deal
      const delEntries = db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(deal.id);
      const delEvents = db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(deal.id);

      // Create revenue events
      await createRevenueEventsForDeal(deal.id);

      // Get new revenue events and process each
      const events = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ?').all(deal.id) as Array<{ id: string }>;

      for (const ev of events) {
        const entryId = await processRevenueEvent(ev.id);
        if (entryId) totalEntries++;
        totalEvents++;
      }

      if (events.length > 0) {
        console.log(`  ✓ ${deal.client_name} (${deal.close_date}): ${events.length} events, ${events.length} entries`);
      }
    } catch (err: any) {
      console.error(`  ✗ ${deal.client_name}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone. Processed ${deals.length} deals, ${totalEvents} revenue events, ${totalEntries} commission entries.`);
  if (errors > 0) {
    console.log(`  ${errors} deal(s) had errors.`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
