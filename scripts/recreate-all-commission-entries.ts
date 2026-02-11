import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';
import { parseISO, addDays, format } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

// Standalone functions to avoid server-only import issues
async function createRevenueEvent(
  dealId: string,
  serviceId: string | null,
  bdrId: string,
  amountCollected: number,
  collectionDate: Date,
  billingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal',
  paymentStage: 'invoice' | 'completion' | 'renewal' | 'scheduled',
  commissionable: boolean = true
): Promise<string> {
  const db = getLocalDB();
  const eventId = generateUUID();
  const collectionDateStr = collectionDate.toISOString().split('T')[0];
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO revenue_events (
      id, deal_id, service_id, bdr_id, amount_collected,
      collection_date, billing_type, payment_stage, commissionable,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId, dealId, serviceId, bdrId, amountCollected,
    collectionDateStr, billingType, paymentStage, commissionable ? 1 : 0,
    now, now
  );

  return eventId;
}

async function createRevenueEventsForDeal(dealId: string): Promise<void> {
  const db = getLocalDB();
  
  // Get deal
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
  if (!deal) {
    throw new Error('Deal not found');
  }

  // Get deal services
  const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(dealId) as any[];

  if (services.length === 0) {
    return;
  }

  // Get base dates
  const baseDate = deal.close_date || deal.proposal_date;
  if (!baseDate) {
    throw new Error('Deal must have either close_date or proposal_date');
  }
  const closeDate = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
  const firstPaymentDate = addDays(closeDate, 7);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Create revenue events for each service based on billing type
  for (const service of services) {
    if (service.billing_type === 'one_off') {
      // One-off: revenue collected on close_date (customer pays immediately)
      await createRevenueEvent(
        dealId,
        service.id,
        deal.bdr_id,
        service.commissionable_value,
        closeDate,
        'one_off',
        'invoice',
        true
      );
    } else if (service.billing_type === 'mrr') {
      // Monthly recurring: first payment on close_date + 7 days, then every 30 days
      const contractMonths = service.contract_months || 12;
      const monthlyAmount = (service.monthly_price || 0) * (service.quantity || 1);
      
      for (let i = 0; i < contractMonths; i++) {
        const paymentDate = addDays(firstPaymentDate, i * 30); // First: +0 days, then +30, +60, +90...
        const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
        
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          monthlyAmount,
          paymentDate,
          'monthly',
          paymentStage,
          true
        );
      }
    } else if (service.billing_type === 'quarterly') {
      // Quarterly recurring: first payment on close_date + 7 days, then every 90 days
      const contractQuarters = service.contract_quarters || 4;
      const quarterlyAmount = (service.quarterly_price || 0) * (service.quantity || 1);
      
      for (let i = 0; i < contractQuarters; i++) {
        const paymentDate = addDays(firstPaymentDate, i * 90); // First: +0 days, then +90, +180, +270...
        const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
        
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          quarterlyAmount,
          paymentDate,
          'quarterly',
          paymentStage,
          true
        );
      }
    } else if (service.billing_type === 'deposit') {
      // Deposit: 50/50 split
      // First 50%: collected on acceptance (close_date + 7 days)
      const firstHalfAmount = service.commissionable_value * 0.5;
      const firstHalfDate = firstPaymentDate; // close_date + 7 days
      const firstHalfStage = firstHalfDate <= today ? 'completion' : 'scheduled';
      
      await createRevenueEvent(
        dealId,
        service.id,
        deal.bdr_id,
        firstHalfAmount,
        firstHalfDate,
        'one_off',
        firstHalfStage,
        true
      );
      
      // Second 50%: collected 60 days after the first 50% payment day
      const secondHalfAmount = service.commissionable_value * 0.5;
      const secondHalfDate = addDays(firstPaymentDate, 60); // 60 days after first payment
      const secondHalfStage = secondHalfDate <= today ? 'completion' : 'scheduled';
      
      await createRevenueEvent(
        dealId,
        service.id,
        deal.bdr_id,
        secondHalfAmount,
        secondHalfDate,
        'one_off',
        secondHalfStage,
        true
      );
    }
  }
}

async function processRevenueEvent(eventId: string): Promise<string | null> {
  const db = getLocalDB();

  // Get revenue event
  const event = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(eventId) as any;
  if (!event) {
    throw new Error('Revenue event not found');
  }

  if (!event.commissionable) {
    return null;
  }

  // Get deal to access close_date
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(event.deal_id) as any;
  if (!deal) {
    throw new Error('Deal not found');
  }

  // Get commission rules
  const rules = db.prepare('SELECT * FROM commission_rules LIMIT 1').get() as any;
  if (!rules) {
    throw new Error('Commission rules not found');
  }

  // Calculate commission amount
  const commissionRate = rules.base_rate || 0.025;
  const commissionAmount = event.amount_collected * commissionRate;

  // Get payout delay days
  const payoutDelayDays = rules.payout_delay_days || 30;

  // collection_date and payable_date are the same (both scheduled 7 days after close date)
  const accrualDate = event.collection_date;
  const payableDate = event.collection_date; // Same as collection_date

  // Create commission entry
  const entryId = generateUUID();
  const month = accrualDate;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO commission_entries (
      id, deal_id, bdr_id, revenue_event_id, month,
      accrual_date, payable_date, amount, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entryId, event.deal_id, event.bdr_id, eventId, month,
    accrualDate, payableDate, commissionAmount, 'accrued',
    now, now
  );

  return entryId;
}

async function recreateAllCommissionEntries() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  console.log('Recreating all commission entries...\n');

  // Get all closed-won deals with close_date
  const deals = db.prepare(`
    SELECT id, client_name, close_date, proposal_date, bdr_id, status
    FROM deals 
    WHERE status = 'closed-won' AND close_date IS NOT NULL
    ORDER BY created_at
  `).all() as Array<{
    id: string;
    client_name: string;
    close_date: string;
    proposal_date: string;
    bdr_id: string;
    status: string;
  }>;

  console.log(`Found ${deals.length} closed-won deals to process\n`);

  let processed = 0;
  let errors = 0;
  let totalRevenueEvents = 0;
  let totalCommissionEntries = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const deal of deals) {
    try {
      console.log(`Processing deal: ${deal.client_name} (${deal.id})`);
      console.log(`  Close Date: ${deal.close_date}`);
      
      // Get services for this deal
      const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(deal.id) as any[];
      console.log(`  Services: ${services.length}`);
      services.forEach((s, i) => {
        console.log(`    ${i+1}. ${s.service_name} - ${s.billing_type} - $${s.commissionable_value}`);
      });

      // Create revenue events for all services
      console.log(`  Creating revenue events...`);
      await createRevenueEventsForDeal(deal.id);

      // Count revenue events created
      const revenueEventsCount = db.prepare('SELECT COUNT(*) as count FROM revenue_events WHERE deal_id = ?').get(deal.id) as { count: number };
      console.log(`  Created ${revenueEventsCount.count} revenue events`);
      totalRevenueEvents += revenueEventsCount.count;

      // Process revenue events that have been collected (collection_date <= today)
      const revenueEvents = db.prepare(`
        SELECT id, collection_date, billing_type, amount_collected
        FROM revenue_events 
        WHERE deal_id = ? AND collection_date <= ?
        ORDER BY collection_date
      `).all(deal.id, today) as Array<{ id: string; collection_date: string; billing_type: string; amount_collected: number }>;

      console.log(`  Processing ${revenueEvents.length} revenue events that have been collected...`);
      let processedEvents = 0;
      for (const event of revenueEvents) {
        try {
          await processRevenueEvent(event.id);
          processedEvents++;
        } catch (error: any) {
          console.error(`    Error processing event ${event.id}:`, error.message);
        }
      }
      console.log(`  ✓ Created ${processedEvents} commission entries\n`);
      totalCommissionEntries += processedEvents;
      processed++;
    } catch (error: any) {
      console.error(`  ✗ Error processing deal ${deal.id}:`, error.message);
      console.error(`  Stack:`, error.stack);
      errors++;
      console.log('');
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total deals: ${deals.length}`);
  console.log(`Successfully processed: ${processed}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total revenue events created: ${totalRevenueEvents}`);
  console.log(`Total commission entries created: ${totalCommissionEntries}`);
  console.log('\n✓ Commission entries recreation complete!');
}

recreateAllCommissionEntries().then(() => {
  console.log('\nDone!');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

