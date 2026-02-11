/**
 * Script to recreate all commission entries
 * Goes deal by deal, service by service, processing revenue events
 */

import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';
import { parseISO, addDays, format } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

// Standalone processRevenueEvent function to avoid server-only imports
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

  // Get deal to access close_date and first_invoice_date
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

  // Check if this is a deposit service - if so, use first_invoice_date for commission allocation
  let accrualDate: string;
  const service = event.service_id 
    ? db.prepare('SELECT * FROM deal_services WHERE id = ?').get(event.service_id) as any
    : null;
  const isDeposit = service?.billing_type === 'deposit';
  
  if (isDeposit && deal.first_invoice_date) {
    // For deposit services, use first_invoice_date for commission allocation month
    accrualDate = typeof deal.first_invoice_date === 'string' 
      ? deal.first_invoice_date.split('T')[0] 
      : format(new Date(deal.first_invoice_date), 'yyyy-MM-dd');
  } else {
    // For other services, use collection_date
    accrualDate = event.collection_date;
  }
  
  // Calculate dates
  // accrual_date is when commission is earned (first_invoice_date for deposits, collection_date for others)
  // payable_date is when commission becomes payable (accrual_date + payout_delay_days)
  const accrualDateObj = parseISO(accrualDate);
  const payableDateObj = addDays(accrualDateObj, payoutDelayDays);
  const payableDate = format(payableDateObj, 'yyyy-MM-dd');

  // Create commission entry
  const entryId = generateUUID();
  const month = accrualDate; // Month for BDR allocation
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

async function recreateCommissionsDealByDeal() {
  if (!USE_LOCAL_DB) {
    console.log('This script currently only supports local DB mode.');
    console.log('For Supabase, you can run a similar query directly in the database.');
    return;
  }

  const db = getLocalDB();

  console.log('=== Recreating Commission Entries Deal by Deal ===\n');

  // Get all deals
  const deals = db.prepare(`
    SELECT d.id, d.client_name, d.close_date, d.first_invoice_date, d.status
    FROM deals d
    WHERE d.status = 'closed-won'
    ORDER BY d.close_date ASC, d.created_at ASC
  `).all() as any[];

  console.log(`Found ${deals.length} closed-won deals\n`);

  let totalDealsProcessed = 0;
  let totalServicesProcessed = 0;
  let totalEventsProcessed = 0;
  let totalEntriesCreated = 0;
  let errors = 0;

  for (const deal of deals) {
    console.log(`\nDeal: ${deal.client_name} (${deal.id})`);
    console.log(`  Close Date: ${deal.close_date || 'N/A'}`);
    console.log(`  First Invoice Date: ${deal.first_invoice_date || 'N/A'}`);

    // Get all services for this deal
    const services = db.prepare(`
      SELECT id, service_name, billing_type, commissionable_value
      FROM deal_services
      WHERE deal_id = ?
      ORDER BY created_at ASC
    `).all(deal.id) as any[];

    if (services.length === 0) {
      console.log(`  No services found - skipping`);
      continue;
    }

    console.log(`  Services: ${services.length}`);

    let dealEventsProcessed = 0;
    let dealEntriesCreated = 0;

    // Process each service
    for (const service of services) {
      console.log(`    Service: ${service.service_name} - ${service.billing_type}`);

      // Get all revenue events for this service
      const revenueEvents = db.prepare(`
        SELECT id, collection_date, amount_collected, billing_type, payment_stage, commissionable
        FROM revenue_events
        WHERE deal_id = ? AND service_id = ?
        ORDER BY collection_date ASC
      `).all(deal.id, service.id) as any[];

      if (revenueEvents.length === 0) {
        console.log(`      No revenue events found`);
        continue;
      }

      console.log(`      Revenue events: ${revenueEvents.length}`);

      // Process each revenue event
      for (const event of revenueEvents) {
        if (!event.commissionable) {
          console.log(`      Event ${event.id}: Not commissionable - skipping`);
          continue;
        }

        try {
          const entryId = await processRevenueEvent(event.id);
          if (entryId) {
            dealEntriesCreated++;
            totalEntriesCreated++;
            console.log(`      ✓ Processed event ${event.id.substring(0, 8)}... (${event.collection_date}) - Entry created`);
          } else {
            console.log(`      ⚠ Event ${event.id.substring(0, 8)}... - No entry created (not commissionable)`);
          }
          dealEventsProcessed++;
          totalEventsProcessed++;
        } catch (error: any) {
          errors++;
          console.log(`      ✗ Error processing event ${event.id.substring(0, 8)}...: ${error.message}`);
        }
      }

      totalServicesProcessed++;
    }

    // Also check for revenue events without a service_id (legacy or one-off deals)
    const orphanEvents = db.prepare(`
      SELECT id, collection_date, amount_collected, billing_type, payment_stage, commissionable
      FROM revenue_events
      WHERE deal_id = ? AND service_id IS NULL
      ORDER BY collection_date ASC
    `).all(deal.id) as any[];

    if (orphanEvents.length > 0) {
      console.log(`    Orphan revenue events (no service): ${orphanEvents.length}`);
      for (const event of orphanEvents) {
        if (!event.commissionable) {
          continue;
        }
        try {
          const entryId = await processRevenueEvent(event.id);
          if (entryId) {
            dealEntriesCreated++;
            totalEntriesCreated++;
            console.log(`      ✓ Processed orphan event ${event.id.substring(0, 8)}... (${event.collection_date})`);
          }
          dealEventsProcessed++;
          totalEventsProcessed++;
        } catch (error: any) {
          errors++;
          console.log(`      ✗ Error processing orphan event ${event.id.substring(0, 8)}...: ${error.message}`);
        }
      }
    }

    if (dealEventsProcessed > 0) {
      console.log(`  Summary: ${dealEventsProcessed} events processed, ${dealEntriesCreated} entries created`);
      totalDealsProcessed++;
    }
  }

  console.log('\n=== Final Summary ===');
  console.log(`Deals processed: ${totalDealsProcessed}`);
  console.log(`Services processed: ${totalServicesProcessed}`);
  console.log(`Revenue events processed: ${totalEventsProcessed}`);
  console.log(`Commission entries created: ${totalEntriesCreated}`);
  console.log(`Errors: ${errors}`);
  console.log('\n✅ Recreation complete!');
}

recreateCommissionsDealByDeal()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });

