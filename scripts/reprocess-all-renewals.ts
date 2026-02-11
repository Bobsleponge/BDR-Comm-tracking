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

async function processRevenueEvent(eventId: string): Promise<string | null> {
  const db = getLocalDB();

  // Get revenue event
  const event = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(eventId) as any;
  if (!event) {
    throw new Error('Revenue event not found');
  }

  if (!event.commissionable) {
    return null; // Not commissionable
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

  // Calculate commission amount (2.5% base rate for all, including renewals)
  const commissionRate = rules.base_rate || 0.025;
  const commissionAmount = event.amount_collected * commissionRate;

  // Get payout delay days
  const payoutDelayDays = rules.payout_delay_days || 30;

  // Calculate dates
  const accrualDate = event.collection_date;
  const accrualDateObj = parseISO(accrualDate);
  const payableDateObj = addDays(accrualDateObj, payoutDelayDays);
  const payableDate = format(payableDateObj, 'yyyy-MM-dd');

  // Create commission entry
  const entryId = generateUUID();
  const month = accrualDate; // Keep month for backward compatibility
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

  // Get base dates
  const getBaseDate = (deal: any): Date => {
    const baseDate = deal.close_date || deal.proposal_date;
    if (!baseDate) {
      throw new Error('Deal must have either close_date or proposal_date');
    }
    return typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
  };

  const calculateFirstPaymentDate = (deal: any): Date => {
    const baseDateObj = getBaseDate(deal);
    return addDays(baseDateObj, 7);
  };

  // Get deal services
  const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(dealId) as any[];

  if (services.length === 0) {
    return;
  }

  // Get base dates
  const closeDate = getBaseDate(deal);
  const firstPaymentDate = calculateFirstPaymentDate(deal);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // For renewal deals, get original deal services to identify which services are renewals vs new/upsells
  let originalServices: any[] = [];
  let originalDealValue: number | null = null;
  
  if (deal.is_renewal) {
    // Get original deal value
    if (deal.original_deal_value != null && deal.original_deal_value !== undefined) {
      originalDealValue = Number(deal.original_deal_value);
    } else if (deal.original_deal_id) {
      const originalDeal = db.prepare('SELECT deal_value FROM deals WHERE id = ?').get(deal.original_deal_id) as any;
      if (originalDeal) {
        originalDealValue = Number(originalDeal.deal_value || 0);
      }
    }
    
    // Get original deal services to match against
    if (deal.original_deal_id) {
      originalServices = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(deal.original_deal_id) as any[];
    }
  }

  // Create revenue events for each service based on billing type
  for (const service of services) {
    // Check if this service is a renewal (exists in original deal) or new/upsell
    const isRenewalService = deal.is_renewal && originalServices.some(
      (os: any) => os.service_name === service.service_name
    );
    
    let serviceAmount = Number(service.commissionable_value || 0);
    let serviceBillingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal' = service.billing_type === 'mrr' ? 'monthly' : 
                                                                              service.billing_type === 'quarterly' ? 'quarterly' : 'one_off';
    
    // For renewal services, calculate uplift amount for this specific service
    if (isRenewalService && originalDealValue != null) {
      const matchingOriginalService = originalServices.find(
        (os: any) => os.service_name === service.service_name
      );
      
      if (matchingOriginalService) {
        const originalServiceValue = Number(matchingOriginalService.commissionable_value || 0);
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
    }
    
    // For renewal services, always create a single one-off revenue event for the uplift (regardless of billing type)
    if (isRenewalService && serviceBillingType === 'renewal') {
      await createRevenueEvent(
        dealId,
        service.id,
        deal.bdr_id,
        serviceAmount,
        closeDate,
        'renewal',
        'renewal',
        true
      );
    } else if (service.billing_type === 'one_off') {
    } else if (service.billing_type === 'one_off') {
      // One-off: revenue collected on close_date (customer pays immediately)
      await createRevenueEvent(
        dealId,
        service.id,
        deal.bdr_id,
        serviceAmount,
        closeDate,
        serviceBillingType,
        'invoice',
        true
      );
    } else if (service.billing_type === 'mrr') {
      // Monthly recurring: first payment on close_date + 7 days, then every 30 days
      const contractMonths = service.contract_months || 12;
      const monthlyAmount = (service.monthly_price || 0) * (service.quantity || 1);
      
      for (let i = 0; i < contractMonths; i++) {
        const paymentDate = addDays(firstPaymentDate, i * 30);
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
      // Quarterly recurring: first payment on close_date + 7 days, then every 90 days
      const contractQuarters = service.contract_quarters || 4;
      const quarterlyAmount = (service.quarterly_price || 0) * (service.quantity || 1);
      
      for (let i = 0; i < contractQuarters; i++) {
        const paymentDate = addDays(firstPaymentDate, i * 90);
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
      const firstHalfAmount = service.commissionable_value * 0.5;
      const firstHalfDate = firstPaymentDate;
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
      
      const secondHalfAmount = service.commissionable_value * 0.5;
      const secondHalfDate = addDays(firstPaymentDate, 60);
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

async function reprocessRenewalDeal(dealId: string) {
  const db = getLocalDB();

  // Get deal info
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
  if (!deal) {
    throw new Error(`Deal ${dealId} not found`);
  }

  console.log(`\nReprocessing renewal deal: ${deal.client_name} (${deal.id})`);
  console.log(`  Deal Value: $${deal.deal_value.toFixed(2)}`);
  console.log(`  Original Deal Value: $${(deal.original_deal_value || 0).toFixed(2)}`);
  
  // Calculate uplift
  let originalValue: number | null = null;
  if (deal.original_deal_value != null && deal.original_deal_value !== undefined) {
    originalValue = Number(deal.original_deal_value);
  } else if (deal.original_deal_id) {
    const originalDeal = db.prepare('SELECT deal_value FROM deals WHERE id = ?').get(deal.original_deal_id) as any;
    if (originalDeal) {
      originalValue = Number(originalDeal.deal_value || 0);
    }
  }
  
  if (originalValue != null) {
    const uplift = Math.max(0, Number(deal.deal_value || 0) - originalValue);
    console.log(`  Uplift Amount: $${uplift.toFixed(2)}`);
    console.log(`  Expected Commission (2.5%): $${(uplift * 0.025).toFixed(2)}`);
  }

  // Delete existing revenue events and commission entries for this deal
  const existingEntries = db.prepare('SELECT id, amount FROM commission_entries WHERE deal_id = ?').all(dealId) as Array<{ id: string; amount: number }>;
  const existingEvents = db.prepare('SELECT id, amount_collected FROM revenue_events WHERE deal_id = ?').all(dealId) as Array<{ id: string; amount_collected: number }>;
  
  const totalExistingCommission = existingEntries.reduce((sum, e) => sum + Number(e.amount), 0);
  console.log(`  Existing: ${existingEntries.length} commission entries ($${totalExistingCommission.toFixed(2)}), ${existingEvents.length} revenue events`);

  // Delete commission entries
  db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(dealId);

  // Delete revenue events
  db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);

  // Recreate revenue events (will use new renewal logic)
  await createRevenueEventsForDeal(dealId);

  // Get all revenue events for this deal
  const revenueEvents = db.prepare('SELECT id, collection_date, amount_collected, billing_type FROM revenue_events WHERE deal_id = ?').all(dealId) as Array<{ id: string; collection_date: string; amount_collected: number; billing_type: string }>;
  console.log(`  Created ${revenueEvents.length} revenue event(s)`);
  
  if (revenueEvents.length > 0) {
    revenueEvents.forEach(e => {
      console.log(`    - $${e.amount_collected.toFixed(2)} (${e.billing_type}) on ${e.collection_date}`);
    });
  }

  // Process revenue events that have been collected (collection_date <= today)
  const today = new Date().toISOString().split('T')[0];
  const eventsToProcess = revenueEvents.filter(e => e.collection_date <= today);
  
  let processed = 0;
  let errors = 0;

  for (const event of eventsToProcess) {
    try {
      await processRevenueEvent(event.id);
      processed++;
    } catch (error: any) {
      console.error(`    Error processing event ${event.id}:`, error.message);
      errors++;
    }
  }

  if (processed > 0 || errors > 0) {
    console.log(`  Processed ${processed} revenue event(s), ${errors} error(s)`);
  }

  // Show final commission
  const finalEntries = db.prepare('SELECT amount FROM commission_entries WHERE deal_id = ?').all(dealId) as Array<{ amount: number }>;
  const totalNewCommission = finalEntries.reduce((sum, e) => sum + Number(e.amount), 0);
  console.log(`  New Commission: $${totalNewCommission.toFixed(2)} (${finalEntries.length} entries)`);
  
  if (totalExistingCommission !== totalNewCommission) {
    const diff = totalNewCommission - totalExistingCommission;
    console.log(`  Change: ${diff >= 0 ? '+' : ''}$${diff.toFixed(2)}`);
  }
}

async function reprocessAllRenewals() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  // Get all renewal deals
  const renewalDeals = db.prepare(`
    SELECT id, client_name, deal_value, original_deal_value, original_deal_id, status
    FROM deals 
    WHERE is_renewal = 1 AND status = 'closed-won'
    ORDER BY client_name
  `).all() as Array<{ id: string; client_name: string; deal_value: number; original_deal_value: number | null; original_deal_id: string | null; status: string }>;

  if (renewalDeals.length === 0) {
    console.log('No renewal deals found');
    process.exit(0);
  }

  console.log(`Found ${renewalDeals.length} renewal deal(s) to reprocess\n`);
  console.log('='.repeat(80));

  let successCount = 0;
  let errorCount = 0;

  for (const deal of renewalDeals) {
    try {
      await reprocessRenewalDeal(deal.id);
      successCount++;
    } catch (error: any) {
      console.error(`\n✗ Error reprocessing ${deal.client_name}:`, error.message);
      errorCount++;
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`\nSummary:`);
  console.log(`  ✓ Successfully reprocessed: ${successCount}`);
  if (errorCount > 0) {
    console.log(`  ✗ Errors: ${errorCount}`);
  }
  console.log(`  Total: ${renewalDeals.length}`);
}

reprocessAllRenewals().then(() => {
  console.log('\nDone!');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

