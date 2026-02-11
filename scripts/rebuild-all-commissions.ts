/**
 * Script to rebuild all commission entries for all deals using updated logic
 * Processes deals one by one to ensure proper handling
 */

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
  if (USE_LOCAL_DB) {
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
  } else {
    const { createClient } = await import('../lib/supabase/server');
    const supabase = await createClient() as any;
    const result = await supabase
      .from('revenue_events')
      .insert({
        deal_id: dealId,
        service_id: serviceId,
        bdr_id: bdrId,
        amount_collected: amountCollected,
        collection_date: collectionDate.toISOString().split('T')[0],
        billing_type: billingType,
        payment_stage: paymentStage,
        commissionable,
      })
      .select('id')
      .single();

    if (result.error) {
      throw new Error(`Failed to create revenue event: ${result.error.message}`);
    }

    return result.data.id;
  }
}

async function processRevenueEvent(eventId: string): Promise<string | null> {
  if (USE_LOCAL_DB) {
    const db = getLocalDB();

    // Get revenue event
    const event = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(eventId) as any;
    if (!event) {
      throw new Error('Revenue event not found');
    }

    if (!event.commissionable) {
      return null; // Not commissionable
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
  } else {
    const { createClient } = await import('../lib/supabase/server');
    const supabase = await createClient() as any;
    
    const eventResult = await supabase
      .from('revenue_events')
      .select('*')
      .eq('id', eventId)
      .single();

    if (eventResult.error || !eventResult.data) {
      throw new Error('Revenue event not found');
    }

    const event = eventResult.data;
    if (!event.commissionable) {
      return null;
    }

    // Get commission rules
    const rulesResult = await supabase
      .from('commission_rules')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (rulesResult.error || !rulesResult.data) {
      throw new Error('Commission rules not found');
    }

    const rules = rulesResult.data;
    const commissionRate = rules.base_rate || 0.025;
    const commissionAmount = event.amount_collected * commissionRate;
    const payoutDelayDays = rules.payout_delay_days || 30;

    const accrualDate = event.collection_date;
    const accrualDateObj = parseISO(accrualDate);
    const payableDateObj = addDays(accrualDateObj, payoutDelayDays);
    const payableDate = format(payableDateObj, 'yyyy-MM-dd');

    const entryResult = await supabase
      .from('commission_entries')
      .insert({
        deal_id: event.deal_id,
        bdr_id: event.bdr_id,
        revenue_event_id: eventId,
        month: accrualDate,
        accrual_date: accrualDate,
        payable_date: payableDate,
        amount: commissionAmount,
        status: 'accrued',
      })
      .select('id')
      .single();

    if (entryResult.error) {
      throw new Error(`Failed to create commission entry: ${entryResult.error.message}`);
    }

    return entryResult.data.id;
  }
}

async function createRevenueEventsForDeal(dealId: string): Promise<void> {
  if (USE_LOCAL_DB) {
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

    const closeDate = getBaseDate(deal);
    const firstPaymentDate = calculateFirstPaymentDate(deal);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Create revenue events for each service based on billing type
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
  } else {
    // Supabase implementation - similar logic but using Supabase client
    const { createClient } = await import('../lib/supabase/server');
    const supabase = await createClient() as any;

    const dealResult = await supabase
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .single();

    if (dealResult.error || !dealResult.data) {
      throw new Error('Deal not found');
    }

    const deal = dealResult.data;
    
    const servicesResult = await supabase
      .from('deal_services')
      .select('*')
      .eq('deal_id', dealId);

    if (servicesResult.error || !servicesResult.data || servicesResult.data.length === 0) {
      return;
    }

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

    const closeDate = getBaseDate(deal);
    const firstPaymentDate = calculateFirstPaymentDate(deal);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

      for (const service of servicesResult.data) {
        // Check if this service is marked as a renewal (service-level flag)
        const isRenewalService = service.is_renewal === true || service.is_renewal === 1;
        
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
}

async function rebuildAllCommissions() {
  if (USE_LOCAL_DB) {
    const db = getLocalDB();

    console.log('Rebuilding commission entries for all deals...\n');

    // Get all closed-won deals that have a first_invoice_date
    const deals = db.prepare(`
      SELECT id, client_name, deal_value, is_renewal, status
      FROM deals 
      WHERE status = 'closed-won' AND first_invoice_date IS NOT NULL
      ORDER BY client_name
    `).all() as Array<{ id: string; client_name: string; deal_value: number; is_renewal: number; status: string }>;

    console.log(`Found ${deals.length} closed-won deals to process\n`);

    let processed = 0;
    let errors = 0;
    const today = new Date().toISOString().split('T')[0];

    // Process deals one by one
    for (const deal of deals) {
      try {
        console.log(`Processing: ${deal.client_name} (${deal.id})`);
        console.log(`  Deal Value: $${deal.deal_value.toFixed(2)}`);
        console.log(`  Is Renewal: ${deal.is_renewal ? 'Yes' : 'No'}`);

        // Create revenue events for this deal (using updated per-service logic)
        await createRevenueEventsForDeal(deal.id);

        // Get all revenue events for this deal
        const revenueEvents = db.prepare(`
          SELECT id, collection_date, amount_collected, billing_type 
          FROM revenue_events 
          WHERE deal_id = ?
        `).all(deal.id) as Array<{ id: string; collection_date: string; amount_collected: number; billing_type: string }>;

        console.log(`  Created ${revenueEvents.length} revenue event(s)`);

        // Process revenue events that have been collected (collection_date <= today)
        const eventsToProcess = revenueEvents.filter(e => e.collection_date <= today);
        console.log(`  Processing ${eventsToProcess.length} revenue event(s) that are due`);

        let commissionCreated = 0;
        for (const event of eventsToProcess) {
          try {
            const entryId = await processRevenueEvent(event.id);
            if (entryId) {
              commissionCreated++;
            }
          } catch (err: any) {
            console.error(`    Error processing event ${event.id}:`, err.message);
          }
        }

        console.log(`  ✅ Created ${commissionCreated} commission entry/entries\n`);
        processed++;

      } catch (err: any) {
        console.error(`❌ Error processing deal ${deal.id} (${deal.client_name}):`, err.message);
        console.error(`   ${err.stack}\n`);
        errors++;
      }
    }

    console.log('\n=== Summary ===');
    console.log(`Total deals: ${deals.length}`);
    console.log(`Successfully processed: ${processed}`);
    console.log(`Errors: ${errors}`);

  } else {
    const { createClient } = await import('../lib/supabase/server');
    const supabase = await createClient();

    console.log('Rebuilding commission entries for all deals...\n');

    // Get all closed-won deals that have a first_invoice_date
    const { data: deals, error: dealsError } = await supabase
      .from('deals')
      .select('id, client_name, deal_value, is_renewal, status')
      .eq('status', 'closed-won')
      .not('first_invoice_date', 'is', null)
      .order('client_name');

    if (dealsError) {
      throw new Error(`Error fetching deals: ${dealsError.message}`);
    }

    if (!deals || deals.length === 0) {
      console.log('No deals found to process');
      return;
    }

    console.log(`Found ${deals.length} closed-won deals to process\n`);

    let processed = 0;
    let errors = 0;
    const today = new Date().toISOString().split('T')[0];

    // Process deals one by one
    for (const deal of deals) {
      try {
        console.log(`Processing: ${deal.client_name} (${deal.id})`);
        console.log(`  Deal Value: $${deal.deal_value.toFixed(2)}`);
        console.log(`  Is Renewal: ${deal.is_renewal ? 'Yes' : 'No'}`);

        // Create revenue events for this deal (using updated per-service logic)
        await createRevenueEventsForDeal(deal.id);

        // Get all revenue events for this deal
        const { data: revenueEvents, error: eventsError } = await supabase
          .from('revenue_events')
          .select('id, collection_date, amount_collected, billing_type')
          .eq('deal_id', deal.id);

        if (eventsError) {
          throw new Error(`Error fetching revenue events: ${eventsError.message}`);
        }

        console.log(`  Created ${revenueEvents?.length || 0} revenue event(s)`);

        // Process revenue events that have been collected (collection_date <= today)
        const eventsToProcess = (revenueEvents || []).filter((e: any) => e.collection_date <= today);
        console.log(`  Processing ${eventsToProcess.length} revenue event(s) that are due`);

        let commissionCreated = 0;
        for (const event of eventsToProcess) {
          try {
            const entryId = await processRevenueEvent(event.id);
            if (entryId) {
              commissionCreated++;
            }
          } catch (err: any) {
            console.error(`    Error processing event ${event.id}:`, err.message);
          }
        }

        console.log(`  ✅ Created ${commissionCreated} commission entry/entries\n`);
        processed++;

      } catch (err: any) {
        console.error(`❌ Error processing deal ${deal.id} (${deal.client_name}):`, err.message);
        console.error(`   ${err.stack}\n`);
        errors++;
      }
    }

    console.log('\n=== Summary ===');
    console.log(`Total deals: ${deals.length}`);
    console.log(`Successfully processed: ${processed}`);
    console.log(`Errors: ${errors}`);
  }
}

rebuildAllCommissions()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nFatal error:', error);
    process.exit(1);
  });
