/**
 * Reprocess deals closed in a specific month.
 * Creates revenue events and commission entries for each deal.
 *
 * Usage: npx tsx scripts/reprocess-close-month.ts [YYYY-MM]
 * Example: npx tsx scripts/reprocess-close-month.ts 2026-01
 */

import { getLocalDB } from '../lib/db/local-db';
import { createRevenueEventsForDeal, processRevenueEvent } from '../lib/commission/revenue-events-local';

async function reprocessCloseMonth(closeMonth: string) {
  if (process.env.USE_LOCAL_DB !== 'true' && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    console.error('This script only works with local database (USE_LOCAL_DB=true or no Supabase URL)');
    process.exit(1);
  }

  if (!/^\d{4}-\d{2}$/.test(closeMonth)) {
    console.error('Invalid month format. Use YYYY-MM (e.g. 2026-01)');
    process.exit(1);
  }

  const db = getLocalDB();
  const [year, month] = closeMonth.split('-');
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month) - 1 + 1, 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

  const deals = db.prepare(`
    SELECT id, client_name, close_date 
    FROM deals 
    WHERE status = 'closed-won' 
      AND first_invoice_date IS NOT NULL
      AND cancellation_date IS NULL
      AND close_date >= ? AND close_date <= ?
    ORDER BY close_date
  `).all(startDate, endDate) as Array<{ id: string; client_name: string; close_date: string }>;

  if (deals.length === 0) {
    console.log(`No deals closed in ${closeMonth} found.`);
    process.exit(0);
  }

  console.log(`Reprocessing ${deals.length} deal(s) closed in ${closeMonth} (${startDate} to ${endDate})\n`);

  let processed = 0;
  let errors = 0;

  for (const deal of deals) {
    try {
      console.log(`Processing: ${deal.client_name} (closed ${deal.close_date})`);
      
      db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(deal.id);
      db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(deal.id);

      await createRevenueEventsForDeal(deal.id);

      const revenueEvents = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ?')
        .all(deal.id) as Array<{ id: string }>;

      for (const event of revenueEvents) {
        await processRevenueEvent(event.id);
      }

      const entryCount = (db.prepare('SELECT COUNT(*) as c FROM commission_entries WHERE deal_id = ?').get(deal.id) as { c: number }).c;
      console.log(`  ✓ ${revenueEvents.length} revenue events, ${entryCount} commission entries\n`);
      processed++;
    } catch (err: any) {
      console.error(`  ✗ Error: ${err.message}\n`);
      errors++;
    }
  }

  console.log('=== Summary ===');
  console.log(`Processed: ${processed}`);
  if (errors > 0) {
    console.log(`Errors: ${errors}`);
  }
  console.log('\nDone!');
}

const closeMonth = process.argv[2] || '2026-01';
reprocessCloseMonth(closeMonth).then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
