import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';
import { calculateServiceCommission } from '../lib/commission/calculator';
import { createRevenueEventsForDeal, processRevenueEvent } from '../lib/commission/revenue-events';
import { format, addMonths } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function createTestDeal() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  // Get test BDR and client
  const bdr = db.prepare('SELECT id, name FROM bdr_reps LIMIT 1').get() as any;
  if (!bdr) {
    console.error('No BDR reps found. Please create one first.');
    process.exit(1);
  }

  const client = db.prepare('SELECT id, name FROM clients LIMIT 1').get() as any;
  if (!client) {
    console.error('No clients found. Please create one first.');
    process.exit(1);
  }

  console.log(`Creating test deal for BDR: ${bdr.name} (${bdr.id})`);
  console.log(`Client: ${client.name} (${client.id})\n`);

  // Get commission rules
  const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
  const baseRate = rules?.base_rate ?? 0.025;
  console.log(`Using base commission rate: ${(baseRate * 100).toFixed(2)}%\n`);

  // Create deal with multiple services
  const dealId = generateUUID();
  const today = new Date();
  const invoiceDate = format(today, 'yyyy-MM-dd');
  const proposalDate = format(addMonths(today, -1), 'yyyy-MM-dd');
  const closeDate = format(today, 'yyyy-MM-dd');

  // Insert deal
  db.prepare(`
    INSERT INTO deals (
      id, bdr_id, client_id, client_name, service_type, proposal_date, close_date,
      first_invoice_date, deal_value, status, is_renewal, payout_months
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    dealId,
    bdr.id,
    client.id,
    client.name,
    'Multi-Service Deal', // Will be derived from first service
    proposalDate,
    closeDate,
    invoiceDate,
    0, // Will be calculated from services
    'closed-won',
    0,
    12
  );

  console.log(`✓ Created deal: ${dealId}\n`);

  // Create services
  const services = [
    {
      name: 'One-Off Service',
      billing_type: 'one_off',
      unit_price: 5000,
      quantity: 1,
    },
    {
      name: 'Deposit Service',
      billing_type: 'deposit',
      unit_price: 10000,
      quantity: 1,
      completion_date: format(addMonths(today, 2), 'yyyy-MM-dd'),
    },
    {
      name: 'Monthly Recurring Service',
      billing_type: 'mrr',
      monthly_price: 1000,
      quantity: 1,
      contract_months: 12,
    },
    {
      name: 'Quarterly Recurring Service',
      billing_type: 'quarterly',
      quarterly_price: 3000,
      quantity: 1,
      contract_quarters: 4,
    },
  ];

  let totalDealValue = 0;
  const serviceIds: string[] = [];

  console.log('Creating services...\n');
  for (const serviceData of services) {
    const serviceId = generateUUID();
    serviceIds.push(serviceId);

    const commission = calculateServiceCommission(
      serviceData.billing_type as 'one_off' | 'quarterly' | 'mrr' | 'deposit',
      serviceData.unit_price || 0,
      serviceData.monthly_price || null,
      serviceData.quarterly_price || null,
      serviceData.quantity || 1,
      serviceData.contract_months || 12,
      serviceData.contract_quarters || 4,
      null,
      baseRate
    );

    totalDealValue += commission.commissionable_value;

    db.prepare(`
      INSERT INTO deal_services (
        id, deal_id, service_name, billing_type, unit_price, monthly_price,
        quarterly_price, quantity, contract_months, contract_quarters,
        commission_rate, commissionable_value, commission_amount, completion_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      serviceId,
      dealId,
      serviceData.name,
      serviceData.billing_type,
      serviceData.unit_price || 0,
      serviceData.monthly_price || null,
      serviceData.quarterly_price || null,
      serviceData.quantity || 1,
      serviceData.contract_months || 12,
      serviceData.contract_quarters || 4,
      null,
      commission.commissionable_value,
      commission.commission_amount,
      serviceData.completion_date || null
    );

    console.log(`  ✓ ${serviceData.name} (${serviceData.billing_type})`);
    console.log(`    Commissionable Value: $${commission.commissionable_value.toFixed(2)}`);
    console.log(`    Commission Amount: $${commission.commission_amount.toFixed(2)}\n`);
  }

  // Update deal with calculated value and service_type
  db.prepare(`
    UPDATE deals 
    SET deal_value = ?, service_type = ?
    WHERE id = ?
  `).run(totalDealValue, services[0].name, dealId);

  console.log(`✓ Updated deal value: $${totalDealValue.toFixed(2)}\n`);

  // Create revenue events
  console.log('Creating revenue events...\n');
  await createRevenueEventsForDeal(dealId);

  // Get all revenue events
  const revenueEvents = db.prepare(`
    SELECT re.*, ds.service_name
    FROM revenue_events re
    LEFT JOIN deal_services ds ON re.service_id = ds.id
    WHERE re.deal_id = ?
    ORDER BY re.collection_date, ds.service_name
  `).all(dealId) as any[];

  console.log(`Created ${revenueEvents.length} revenue events:\n`);
  revenueEvents.forEach((event, idx) => {
    console.log(`  ${idx + 1}. ${event.service_name || 'Legacy'} - ${event.billing_type}`);
    console.log(`     Amount: $${event.amount_collected.toFixed(2)}`);
    console.log(`     Collection Date: ${event.collection_date}`);
    console.log(`     Payment Stage: ${event.payment_stage}`);
    console.log(`     Commissionable: ${event.commissionable ? 'Yes' : 'No'}\n`);
  });

  // Process revenue events and check commission entries
  console.log('Processing revenue events and creating commission entries...\n');
  
  // Process all events that should be processed (first payments)
  const eventsToProcess = revenueEvents.filter(e => {
    const collectionDate = new Date(e.collection_date);
    return collectionDate <= today && e.commissionable;
  });

  for (const event of eventsToProcess) {
    try {
      await processRevenueEvent(event.id);
      console.log(`  ✓ Processed: ${event.service_name} - ${event.billing_type} (${event.collection_date})`);
    } catch (err: any) {
      console.error(`  ✗ Error processing ${event.id}:`, err.message);
    }
  }

  // Get commission entries
  const commissionEntries = db.prepare(`
    SELECT 
      ce.*,
      ds.service_name,
      re.billing_type,
      re.payment_stage,
      re.amount_collected,
      re.collection_date
    FROM commission_entries ce
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON re.service_id = ds.id
    WHERE ce.deal_id = ?
    ORDER BY ce.accrual_date, ds.service_name
  `).all(dealId) as any[];

  console.log(`\n✓ Created ${commissionEntries.length} commission entries:\n`);
  
  // Group by service
  const byService = new Map<string, any[]>();
  commissionEntries.forEach(entry => {
    const serviceName = entry.service_name || 'Legacy';
    if (!byService.has(serviceName)) {
      byService.set(serviceName, []);
    }
    byService.get(serviceName)!.push(entry);
  });

  byService.forEach((entries, serviceName) => {
    const total = entries.reduce((sum, e) => sum + e.amount, 0);
    console.log(`\n${serviceName}:`);
    console.log(`  Total Commission: $${total.toFixed(2)}`);
    console.log(`  Entries: ${entries.length}`);
    entries.forEach((entry, idx) => {
      console.log(`    ${idx + 1}. $${entry.amount.toFixed(2)} - Status: ${entry.status}`);
      console.log(`       Accrual: ${entry.accrual_date}, Payable: ${entry.payable_date}`);
      console.log(`       Payment Stage: ${entry.payment_stage || 'N/A'}`);
    });
  });

  // Show summary
  const totalCommission = commissionEntries.reduce((sum, e) => sum + e.amount, 0);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Deal ID: ${dealId}`);
  console.log(`Total Deal Value: $${totalDealValue.toFixed(2)}`);
  console.log(`Total Commission Created: $${totalCommission.toFixed(2)}`);
  console.log(`Revenue Events: ${revenueEvents.length}`);
  console.log(`Commission Entries: ${commissionEntries.length}`);
  console.log(`\nServices breakdown:`);
  byService.forEach((entries, serviceName) => {
    const total = entries.reduce((sum, e) => sum + e.amount, 0);
    console.log(`  ${serviceName}: $${total.toFixed(2)}`);
  });

  console.log(`\n✓ Test deal created successfully!`);
  console.log(`\nYou can view this deal in the UI at: /deals/${dealId}`);
}

createTestDeal().then(() => {
  console.log('\nDone!');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

