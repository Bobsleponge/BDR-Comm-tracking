import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';
import { createRevenueEventsForDeal, processRevenueEvent } from '../lib/commission/revenue-events';
import { calculateServiceCommission } from '../lib/commission/calculator';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function addOneOffService(dealId: string) {
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

  console.log(`Adding one-off service to deal: ${deal.client_name} (${deal.id})`);

  // Get commission rules for base rate
  const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
  const baseRate = rules?.base_rate ?? 0.025;

  // Check if one-off service already exists
  const existingOneOff = db.prepare(`
    SELECT * FROM deal_services 
    WHERE deal_id = ? AND billing_type = 'one_off'
  `).get(dealId) as any;

  if (existingOneOff) {
    console.log('One-off service already exists, skipping...');
    return;
  }

  // Create one-off service
  // Example: $10,000 one-off payment
  const unitPrice = 10000;
  const quantity = 1;

  const commission = calculateServiceCommission(
    'one_off',
    unitPrice,
    null, // monthly_price
    null, // quarterly_price
    quantity,
    12, // contract_months (not used for one-off)
    4, // contract_quarters (not used for one-off)
    null, // commission_rate (use base rate)
    baseRate
  );

  const serviceId = generateUUID();
  const invoiceDate = deal.first_invoice_date ? new Date(deal.first_invoice_date) : new Date();

  db.prepare(`
    INSERT INTO deal_services (
      id, deal_id, service_name, billing_type, unit_price, monthly_price,
      quarterly_price, quantity, contract_months, contract_quarters,
      commission_rate, commissionable_value, commission_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    serviceId,
    dealId,
    'One-Off Service',
    'one_off',
    unitPrice,
    null,
    null,
    quantity,
    12,
    4,
    null,
    commission.commissionable_value,
    commission.commission_amount
  );

  console.log(`✓ Created one-off service: $${unitPrice}`);

  // Now reprocess the deal to create revenue events
  console.log('\nCreating revenue events for all services...');
  await createRevenueEventsForDeal(dealId);

  // Process revenue events that have been collected
  const today = new Date().toISOString().split('T')[0];
  const revenueEvents = db.prepare(`
    SELECT id, collection_date, billing_type 
    FROM revenue_events 
    WHERE deal_id = ? AND collection_date <= ?
    ORDER BY collection_date
  `).all(dealId, today) as Array<{ id: string; collection_date: string; billing_type: string }>;

  console.log(`\nProcessing ${revenueEvents.length} revenue events that have been collected...`);

  let processed = 0;
  for (const event of revenueEvents) {
    try {
      await processRevenueEvent(event.id);
      processed++;
      console.log(`  ✓ Processed ${event.billing_type} event (${event.collection_date})`);
    } catch (error: any) {
      console.error(`  ✗ Error processing event ${event.id}:`, error.message);
    }
  }

  console.log(`\n✓ Processed ${processed} revenue events successfully`);

  // Show summary
  const entriesByMonth = db.prepare(`
    SELECT 
      strftime('%Y-%m', payable_date) as month,
      COUNT(*) as count,
      SUM(amount) as total,
      GROUP_CONCAT(DISTINCT re.billing_type) as billing_types
    FROM commission_entries ce
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    WHERE ce.deal_id = ?
    GROUP BY strftime('%Y-%m', payable_date)
    ORDER BY month
  `).all(dealId) as Array<{ month: string; count: number; total: number; billing_types: string }>;

  if (entriesByMonth.length > 0) {
    console.log(`\nCommission by payable month:`);
    entriesByMonth.forEach(m => {
      console.log(`  ${m.month}: ${m.count} entries, $${m.total.toFixed(2)} (${m.billing_types || 'N/A'})`);
    });
  }

  // Show all revenue events (including future ones)
  const allEvents = db.prepare(`
    SELECT 
      collection_date,
      billing_type,
      amount_collected,
      payment_stage,
      CASE WHEN collection_date <= date('now') THEN 'collected' ELSE 'scheduled' END as status
    FROM revenue_events
    WHERE deal_id = ?
    ORDER BY collection_date
  `).all(dealId) as Array<{ collection_date: string; billing_type: string; amount_collected: number; payment_stage: string; status: string }>;

  console.log(`\nAll revenue events (${allEvents.length} total):`);
  allEvents.forEach(e => {
    console.log(`  ${e.collection_date}: $${e.amount_collected} (${e.billing_type}, ${e.payment_stage}, ${e.status})`);
  });
}

// Get deal ID from command line
const dealId = process.argv[2] || 'd5298566-7368-403e-848c-d2a4e25d9bf7';

addOneOffService(dealId).then(() => {
  console.log('\nDone!');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});



