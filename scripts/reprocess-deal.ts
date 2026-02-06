import { getLocalDB } from '../lib/db/local-db';
import { createRevenueEventsForDeal, processRevenueEvent } from '../lib/commission/revenue-events';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function reprocessDeal(dealId: string) {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  // Get deal info
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
  if (!deal) {
    console.error(`Deal ${dealId} not found`);
    process.exit(1);
  }

  console.log(`Reprocessing deal: ${deal.client_name} (${deal.id})`);
  console.log(`Status: ${deal.status}, First Invoice Date: ${deal.first_invoice_date}`);

  // Delete existing revenue events and commission entries for this deal
  console.log('\nCleaning up existing revenue events and commission entries...');
  
  // Get commission entry IDs first (for logging)
  const existingEntries = db.prepare('SELECT id FROM commission_entries WHERE deal_id = ?').all(dealId) as Array<{ id: string }>;
  const existingEvents = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ?').all(dealId) as Array<{ id: string }>;
  
  console.log(`  - Found ${existingEntries.length} existing commission entries`);
  console.log(`  - Found ${existingEvents.length} existing revenue events`);

  // Delete commission entries
  db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(dealId);
  console.log('  - Deleted commission entries');

  // Delete revenue events
  db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);
  console.log('  - Deleted revenue events');

  // Recreate revenue events
  console.log('\nCreating revenue events...');
  await createRevenueEventsForDeal(dealId);

  // Get all revenue events for this deal
  const revenueEvents = db.prepare('SELECT id, collection_date FROM revenue_events WHERE deal_id = ?').all(dealId) as Array<{ id: string; collection_date: string }>;
  console.log(`  - Created ${revenueEvents.length} revenue events`);

  // Process only revenue events that have been collected (collection_date <= today)
  const today = new Date().toISOString().split('T')[0];
  const eventsToProcess = revenueEvents.filter(e => e.collection_date <= today);
  
  console.log(`\nProcessing ${eventsToProcess.length} revenue events that have been collected (collection_date <= ${today})...`);
  
  let processed = 0;
  let errors = 0;

  for (const event of eventsToProcess) {
    try {
      await processRevenueEvent(event.id);
      processed++;
    } catch (error: any) {
      console.error(`  Error processing event ${event.id}:`, error.message);
      errors++;
    }
  }

  console.log(`\n✓ Processed ${processed} revenue events successfully`);
  if (errors > 0) {
    console.log(`✗ ${errors} errors occurred`);
  }

  // Show summary
  const finalEntries = db.prepare('SELECT COUNT(*) as count FROM commission_entries WHERE deal_id = ?').get(dealId) as { count: number };
  const finalEvents = db.prepare('SELECT COUNT(*) as count FROM revenue_events WHERE deal_id = ?').get(dealId) as { count: number };
  
  console.log(`\nFinal counts:`);
  console.log(`  - Revenue events: ${finalEvents.count}`);
  console.log(`  - Commission entries: ${finalEntries.count}`);

  // Show commission entries by payable month
  const entriesByMonth = db.prepare(`
    SELECT 
      strftime('%Y-%m', payable_date) as month,
      COUNT(*) as count,
      SUM(amount) as total
    FROM commission_entries
    WHERE deal_id = ?
    GROUP BY strftime('%Y-%m', payable_date)
    ORDER BY month
  `).all(dealId) as Array<{ month: string; count: number; total: number }>;

  if (entriesByMonth.length > 0) {
    console.log(`\nCommission by payable month:`);
    entriesByMonth.forEach(m => {
      console.log(`  ${m.month}: ${m.count} entries, $${m.total.toFixed(2)}`);
    });
  }
}

// Get deal ID from command line or use first deal
const dealId = process.argv[2];

if (dealId) {
  reprocessDeal(dealId).then(() => {
    console.log('\nDone!');
    process.exit(0);
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
} else {
  // Get first deal
  const db = getLocalDB();
  const firstDeal = db.prepare('SELECT id, client_name FROM deals WHERE status = ? LIMIT 1').get('closed-won') as { id: string; client_name: string } | undefined;
  
  if (!firstDeal) {
    console.error('No closed-won deals found');
    process.exit(1);
  }

  console.log(`Reprocessing first deal: ${firstDeal.client_name} (${firstDeal.id})\n`);
  reprocessDeal(firstDeal.id).then(() => {
    console.log('\nDone!');
    process.exit(0);
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

