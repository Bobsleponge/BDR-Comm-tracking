import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';
import { createRevenueEventsForDeal, processRevenueEvent } from '../lib/commission/revenue-events';
import { calculateServiceCommission } from '../lib/commission/calculator';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function addQuarterlyService(dealId: string) {
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

  console.log(`Adding quarterly service to deal: ${deal.client_name} (${deal.id})`);

  // Get commission rules for base rate
  const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
  const baseRate = rules?.base_rate ?? 0.025;

  // Check if quarterly service already exists
  const existingQuarterly = db.prepare(`
    SELECT * FROM deal_services 
    WHERE deal_id = ? AND billing_type = 'quarterly'
  `).get(dealId) as any;

  if (existingQuarterly) {
    console.log('Quarterly service already exists, skipping...');
    return;
  }

  // Create quarterly recurring service
  // Example: $5,000 quarterly for 4 quarters
  const quarterlyPrice = 5000;
  const contractQuarters = 4;
  const quantity = 1;

  const commission = calculateServiceCommission(
    'quarterly',
    0, // unit_price not used for quarterly
    null, // monthly_price
    quarterlyPrice,
    quantity,
    12, // contract_months (not used for quarterly)
    contractQuarters,
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
    'Quarterly Recurring Service',
    'quarterly',
    0,
    null,
    quarterlyPrice,
    quantity,
    12,
    contractQuarters,
    null,
    commission.commissionable_value,
    commission.commission_amount
  );

  console.log(`✓ Created quarterly service: $${quarterlyPrice} per quarter for ${contractQuarters} quarters`);

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

// Get deal ID from command line or use first deal
const dealId = process.argv[2];

if (dealId) {
  addQuarterlyService(dealId).then(() => {
    console.log('\nDone!');
    process.exit(0);
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
} else {
  // Get first closed-won deal
  const db = getLocalDB();
  const firstDeal = db.prepare('SELECT id, client_name FROM deals WHERE status = ? LIMIT 1').get('closed-won') as { id: string; client_name: string } | undefined;
  
  if (!firstDeal) {
    console.error('No closed-won deals found');
    process.exit(1);
  }

  console.log(`Adding quarterly service to deal: ${firstDeal.client_name} (${firstDeal.id})\n`);
  addQuarterlyService(firstDeal.id).then(() => {
    console.log('\nDone!');
    process.exit(0);
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

