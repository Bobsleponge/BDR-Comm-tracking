/**
 * Clean rebuild of all commission entries from deals
 * This script:
 * 1. Clears all existing commission entries and revenue events
 * 2. Processes each closed-won deal with first_invoice_date
 * 3. Creates revenue events based on service billing types
 * 4. Processes revenue events to create commission entries
 */

import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';
import { parseISO, addDays, format } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

// Standalone functions
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
  const collectionDateStr = format(collectionDate, 'yyyy-MM-dd'); // Use format to avoid timezone issues
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

  // Get commission rules
  const rules = db.prepare('SELECT * FROM commission_rules LIMIT 1').get() as any;
  if (!rules) {
    throw new Error('Commission rules not found');
  }

  // Calculate commission amount (2.5% base rate)
  const commissionRate = rules.base_rate || 0.025;
  const commissionAmount = event.amount_collected * commissionRate;
  const payoutDelayDays = rules.payout_delay_days || 30;

  // Calculate dates
  const accrualDate = event.collection_date;
  const accrualDateObj = parseISO(accrualDate);
  const payableDateObj = addDays(accrualDateObj, payoutDelayDays);
  const payableDate = format(payableDateObj, 'yyyy-MM-dd');

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

  // Get first_invoice_date (when first payment is received - close_date + 7 days grace period)
  // This is the date when money actually arrives in the account
  const getFirstInvoiceDate = (deal: any): Date => {
    if (deal.first_invoice_date) {
      return typeof deal.first_invoice_date === 'string' 
        ? parseISO(deal.first_invoice_date) 
        : new Date(deal.first_invoice_date);
    }
    // Fallback: calculate from close_date + 7 days if first_invoice_date not set
    const baseDate = deal.close_date || deal.proposal_date;
    if (!baseDate) {
      throw new Error('Deal must have either first_invoice_date, close_date, or proposal_date');
    }
    const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
    return addDays(baseDateObj, 7);
  };

    // Get first_invoice_date (when first payment is received - close_date + 7 days grace period)
    const firstInvoiceDate = getFirstInvoiceDate(deal);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

  // Process each service
  for (const service of services) {
    // Check if this service is marked as a renewal (service-level flag)
    const isRenewalService = service.is_renewal === 1 || service.is_renewal === true;
    
    let serviceAmount = Number(service.commissionable_value || 0);
    let serviceBillingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal' = service.billing_type === 'mrr' ? 'monthly' : 
                                                                                service.billing_type === 'quarterly' ? 'quarterly' : 'one_off';
    
    // For renewal services, calculate uplift amount using the manually entered previous amount
    if (isRenewalService) {
      const originalServiceValue = Number(service.original_service_value || 0);
      const renewalServiceValue = Number(service.commissionable_value || 0);
      const serviceUplift = Math.max(0, renewalServiceValue - originalServiceValue);
      
      if (serviceUplift > 0) {
        // Use uplift amount for renewal service
        serviceAmount = serviceUplift;
        serviceBillingType = 'renewal';
      } else {
        // No uplift, skip this service (no commission)
        continue;
      }
    }
    
      // For renewal services, always create a single one-off revenue event for the uplift
      if (isRenewalService && serviceBillingType === 'renewal') {
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          serviceAmount,
          firstInvoiceDate, // First payment received on first_invoice_date
          'renewal',
          'renewal',
          true
        );
      } else if (service.billing_type === 'one_off') {
        // One-off: revenue collected on first_invoice_date (after 7-day grace period)
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          serviceAmount,
          firstInvoiceDate,
          serviceBillingType,
          'invoice',
          true
        );
      } else if (service.billing_type === 'mrr') {
        // Monthly recurring: first payment on first_invoice_date, then every 30 days from there
        const contractMonths = service.contract_months || 12;
        const monthlyAmount = (service.monthly_price || 0) * (service.quantity || 1);
        
        for (let i = 0; i < contractMonths; i++) {
          const paymentDate = addDays(firstInvoiceDate, i * 30);
          const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
          
          await createRevenueEvent(
            dealId,
            service.id,
            deal.bdr_id,
            monthlyAmount,
            paymentDate,
            serviceBillingType,
            paymentStage,
            true
          );
        }
      } else if (service.billing_type === 'quarterly') {
        // Quarterly recurring: first payment on first_invoice_date, then every 90 days from there
        const contractQuarters = service.contract_quarters || 4;
        const quarterlyAmount = (service.quarterly_price || 0) * (service.quantity || 1);
        
        for (let i = 0; i < contractQuarters; i++) {
          const paymentDate = addDays(firstInvoiceDate, i * 90);
          const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
          
          await createRevenueEvent(
            dealId,
            service.id,
            deal.bdr_id,
            quarterlyAmount,
            paymentDate,
            serviceBillingType,
            paymentStage,
            true
          );
        }
      } else if (service.billing_type === 'deposit') {
        // Deposit: 50/50 split
        // First 50%: collected on first_invoice_date (close_date + 7 days, when proposal is won)
        const firstHalfAmount = service.commissionable_value * 0.5;
        const firstHalfDate = firstInvoiceDate;
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
        
        // Second 50%: collected on completion_date (scheduled when creating the deal)
        if (service.completion_date) {
          const secondHalfAmount = service.commissionable_value * 0.5;
          const secondHalfDate = typeof service.completion_date === 'string' 
            ? parseISO(service.completion_date) 
            : new Date(service.completion_date);
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
}

async function rebuildCommissionsClean() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  console.log('=== CLEAN REBUILD OF COMMISSION ENTRIES ===\n');

  // Step 1: Clear all existing data
  console.log('Step 1: Clearing all existing commission entries and revenue events...');
  const commissionDeleted = db.prepare('DELETE FROM commission_entries').run();
  const revenueDeleted = db.prepare('DELETE FROM revenue_events').run();
  console.log(`  ✅ Deleted ${commissionDeleted.changes} commission entries`);
  console.log(`  ✅ Deleted ${revenueDeleted.changes} revenue events\n`);

  // Step 2: Get all closed-won deals with first_invoice_date
  console.log('Step 2: Finding deals to process...');
  const deals = db.prepare(`
    SELECT id, client_name, deal_value, is_renewal, status, first_invoice_date, close_date
    FROM deals 
    WHERE status = 'closed-won' AND first_invoice_date IS NOT NULL
    ORDER BY client_name
  `).all() as Array<{
    id: string;
    client_name: string;
    deal_value: number;
    is_renewal: number;
    status: string;
    first_invoice_date: string;
    close_date: string | null;
  }>;

  console.log(`  ✅ Found ${deals.length} closed-won deals to process\n`);

  // Step 3: Process each deal
  console.log('Step 3: Processing deals and creating revenue events...\n');
  let processed = 0;
  let errors = 0;
  let totalRevenueEvents = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const deal of deals) {
    try {
      // Create revenue events for this deal
      await createRevenueEventsForDeal(deal.id);

      // Count revenue events created
      const revenueEvents = db.prepare(`
        SELECT id, collection_date, amount_collected, billing_type 
        FROM revenue_events 
        WHERE deal_id = ?
      `).all(deal.id) as Array<{
        id: string;
        collection_date: string;
        amount_collected: number;
        billing_type: string;
      }>;

      totalRevenueEvents += revenueEvents.length;
      processed++;

      if (processed % 5 === 0) {
        console.log(`  Processed ${processed}/${deals.length} deals...`);
      }
    } catch (err: any) {
      console.error(`  ❌ Error processing deal ${deal.id} (${deal.client_name}):`, err.message);
      errors++;
    }
  }

  console.log(`\n  ✅ Created ${totalRevenueEvents} revenue events from ${processed} deals`);
  console.log(`  ❌ Errors: ${errors}\n`);

  // Step 4: Process revenue events to create commission entries
  console.log('Step 4: Processing revenue events to create commission entries...');
  const allRevenueEvents = db.prepare(`
    SELECT id, collection_date 
    FROM revenue_events 
    WHERE collection_date <= ? AND commissionable = 1
  `).all(today) as Array<{ id: string; collection_date: string }>;

  console.log(`  Found ${allRevenueEvents.length} revenue events that are due\n`);

  let commissionCreated = 0;
  let commissionErrors = 0;

  for (const event of allRevenueEvents) {
    try {
      const entryId = await processRevenueEvent(event.id);
      if (entryId) {
        commissionCreated++;
      }
    } catch (err: any) {
      console.error(`  ❌ Error processing event ${event.id}:`, err.message);
      commissionErrors++;
    }
  }

  console.log(`  ✅ Created ${commissionCreated} commission entries`);
  console.log(`  ❌ Errors: ${commissionErrors}\n`);

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`Total deals processed: ${processed}`);
  console.log(`Total revenue events created: ${totalRevenueEvents}`);
  console.log(`Total commission entries created: ${commissionCreated}`);
  console.log(`Errors: ${errors + commissionErrors}`);
  console.log('\n✅ Rebuild complete!');
}

rebuildCommissionsClean()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nFatal error:', error);
    process.exit(1);
  });

