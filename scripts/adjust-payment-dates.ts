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
  const collectionDateStr = format(collectionDate, 'yyyy-MM-dd');
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
    } else if (service.billing_type === 'paid_on_completion') {
      const sourceDate = deal.first_invoice_date || service.completion_date;
      if (!sourceDate) continue;
      const completionDate = typeof sourceDate === 'string' ? parseISO(sourceDate) : new Date(sourceDate);
      const dateStr = format(completionDate, 'yyyy-MM-dd');
      // Set first_invoice_date = expected completion (scheduled payment)
      db.prepare('UPDATE deals SET first_invoice_date = ?, updated_at = datetime(\'now\') WHERE id = ?').run(dateStr, dealId);
      const paymentStage = completionDate <= today ? 'completion' : 'scheduled';
      await createRevenueEvent(
        dealId,
        service.id,
        deal.bdr_id,
        service.commissionable_value,
        completionDate,
        'one_off',
        paymentStage,
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

  // Get service to check billing type
  const service = event.service_id 
    ? db.prepare('SELECT * FROM deal_services WHERE id = ?').get(event.service_id) as any
    : null;
  const isDeposit = service?.billing_type === 'deposit';
  const isPaidOnCompletion = service?.billing_type === 'paid_on_completion';

  // For paid_on_completion: accrual = completion date (collection_date), normalized to YYYY-MM-DD
  let accrualDate: string;
  if (isPaidOnCompletion) {
    accrualDate = typeof event.collection_date === 'string'
      ? event.collection_date.split('T')[0]
      : format(new Date(event.collection_date), 'yyyy-MM-dd');
  } else {
    accrualDate = event.collection_date;
  }
  const accrualDateObj = typeof accrualDate === 'string' ? parseISO(accrualDate) : new Date(accrualDate);
  
  // Calculate payable_date
  let payableDate: string;
  const closeDate = deal.close_date || deal.proposal_date;
  if (!closeDate && !isPaidOnCompletion) {
    throw new Error('Deal must have close_date or proposal_date for commission calculation');
  }
  const closeDateObj = closeDate ? (typeof closeDate === 'string' ? parseISO(closeDate) : new Date(closeDate)) : accrualDateObj;
  
  if (isPaidOnCompletion) {
    // Paid on completion: commission payable 7 days after completion date
    payableDate = format(addDays(accrualDateObj, 7), 'yyyy-MM-dd');
  } else if (isDeposit) {
    // Deposit deals: special handling for 50/50 split
    // First 50%: collection_date = close_date + 7 days (acceptance), payable_date = close_date + 7 days (same day)
    // Second 50%: collection_date = close_date + 67 days (60 days after first), payable_date = collection_date + 7 days
    const acceptanceDate = addDays(closeDateObj, 7); // close_date + 7 days
    const daysFromAcceptance = Math.round((accrualDateObj.getTime() - acceptanceDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysFromAcceptance <= 1) {
      // First 50% payment (on acceptance, 7 days after close_date)
      payableDate = format(acceptanceDate, 'yyyy-MM-dd'); // Same day as collection
    } else {
      // Second 50% payment (60 days after first payment)
      const payableDateObj = addDays(accrualDateObj, 7); // collection_date + 7 days
      payableDate = format(payableDateObj, 'yyyy-MM-dd');
    }
  } else {
    // For other billing types, determine if this is the first payment
    const earlierEvents = db.prepare(`
      SELECT COUNT(*) as count 
      FROM revenue_events 
      WHERE deal_id = ? AND collection_date < ? AND id != ?
    `).get(event.deal_id, accrualDate, eventId) as { count: number };
    
    const isFirstPayment = earlierEvents.count === 0;
    
    if (isFirstPayment) {
      // First payment: payable_date = close_date + 7 days
      const payableDateObj = addDays(closeDateObj, 7);
      payableDate = format(payableDateObj, 'yyyy-MM-dd');
    } else {
      // Subsequent payment: payable_date = collection_date + payout_delay_days
      const payableDateObj = addDays(accrualDateObj, payoutDelayDays);
      payableDate = format(payableDateObj, 'yyyy-MM-dd');
    }
  }

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

async function adjustPaymentDates() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  console.log('Adjusting payment dates for all closed-won deals...\n');

  // Get all closed-won deals with close_date
  const deals = db.prepare(`
    SELECT id, client_name, close_date, proposal_date, first_invoice_date
    FROM deals 
    WHERE status = 'closed-won' AND close_date IS NOT NULL
    ORDER BY created_at
  `).all() as Array<{
    id: string;
    client_name: string;
    close_date: string;
    proposal_date: string;
    first_invoice_date: string | null;
  }>;

  console.log(`Found ${deals.length} deals to process\n`);

  let processed = 0;
  let errors = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const deal of deals) {
    try {
      console.log(`Processing deal: ${deal.client_name} (${deal.id})`);
      console.log(`  Current close_date: ${deal.close_date}`);
      console.log(`  Current first_invoice_date: ${deal.first_invoice_date || 'null'}`);

      // Calculate new first_invoice_date = close_date + 7 days
      const closeDateObj = parseISO(deal.close_date);
      const newFirstInvoiceDate = addDays(closeDateObj, 7);
      const newFirstInvoiceDateStr = format(newFirstInvoiceDate, 'yyyy-MM-dd');

      console.log(`  New first_invoice_date: ${newFirstInvoiceDateStr}`);

      // Delete ALL commission entries for this deal first (to avoid duplicates)
      const deletedAllCommissionEntries = db.prepare(`
        DELETE FROM commission_entries WHERE deal_id = ?
      `).run(deal.id);

      console.log(`  Deleted ${deletedAllCommissionEntries.changes} commission entries`);

      // Delete ALL revenue events for this deal (we'll recreate them all)
      const deletedAllRevenueEvents = db.prepare(`
        DELETE FROM revenue_events WHERE deal_id = ?
      `).run(deal.id);

      console.log(`  Deleted ${deletedAllRevenueEvents.changes} revenue events`);

      // Update first_invoice_date
      db.prepare(`
        UPDATE deals 
        SET first_invoice_date = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(newFirstInvoiceDateStr, deal.id);

      // Recreate all revenue events using the updated createRevenueEventsForDeal function
      console.log(`  Recreating revenue events...`);
      await createRevenueEventsForDeal(deal.id);

      // Process revenue events that have already been collected (collection_date <= today)
      const revenueEvents = db.prepare(`
        SELECT id, collection_date, billing_type 
        FROM revenue_events 
        WHERE deal_id = ? AND collection_date <= ?
        ORDER BY collection_date
      `).all(deal.id, today) as Array<{ id: string; collection_date: string; billing_type: string }>;

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

      console.log(`  ✓ Processed ${processedEvents} revenue events successfully\n`);
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
  console.log('\n✓ Migration complete!');
}

adjustPaymentDates().then(() => {
  console.log('\nDone!');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

