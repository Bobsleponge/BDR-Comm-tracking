/**
 * Script to fix deposit service revenue events
 * Updates the first 50% payment date from first_invoice_date (close_date + 7 days) 
 * to close_date itself, so it stays in the same month as the close date
 */

import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';
import { parseISO, format, addDays } from 'date-fns';

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

async function fixDepositServiceDates() {
  if (!USE_LOCAL_DB) {
    console.log('This script currently only supports local DB mode.');
    console.log('For Supabase, you can run a similar query directly in the database.');
    return;
  }

  const db = getLocalDB();

  console.log('=== Fixing Deposit Service Revenue Event Dates ===\n');

  // Get all deals with deposit services
  const dealsWithDeposits = db.prepare(`
    SELECT DISTINCT d.id, d.close_date, d.first_invoice_date, d.client_name
    FROM deals d
    INNER JOIN deal_services ds ON d.id = ds.deal_id
    WHERE ds.billing_type = 'deposit'
    AND d.close_date IS NOT NULL
  `).all() as any[];

  console.log(`Found ${dealsWithDeposits.length} deals with deposit services\n`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const deal of dealsWithDeposits) {
    const dealId = deal.id;
    const closeDate = deal.close_date;
    const firstInvoiceDate = deal.first_invoice_date;

    if (!closeDate) {
      console.log(`Skipping deal ${dealId} (${deal.client_name}): No close_date`);
      skippedCount++;
      continue;
    }

    // Get deposit services for this deal
    const depositServices = db.prepare(`
      SELECT id, service_name, commissionable_value
      FROM deal_services
      WHERE deal_id = ? AND billing_type = 'deposit'
    `).all(dealId) as any[];

    if (depositServices.length === 0) {
      continue;
    }

    console.log(`\nDeal: ${deal.client_name} (${dealId})`);
    console.log(`  Close Date: ${closeDate}`);
    console.log(`  First Invoice Date: ${firstInvoiceDate || 'N/A'}`);
    console.log(`  Deposit Services: ${depositServices.length}`);

    const closeDateObj = typeof closeDate === 'string' ? parseISO(closeDate) : new Date(closeDate);
    const expectedFirstPaymentDate = format(closeDateObj, 'yyyy-MM-dd');

    // Get revenue events for deposit services in this deal
    for (const service of depositServices) {
      const revenueEvents = db.prepare(`
        SELECT re.*
        FROM revenue_events re
        WHERE re.deal_id = ? 
        AND re.service_id = ?
        AND re.billing_type = 'one_off'
        ORDER BY re.collection_date ASC
      `).all(dealId, service.id) as any[];

      if (revenueEvents.length === 0) {
        console.log(`    Service ${service.service_name}: No revenue events found`);
        continue;
      }

      // The first event should be the first 50% payment
      const firstEvent = revenueEvents[0];
      const firstEventDate = firstEvent.collection_date;
      const firstEventAmount = firstEvent.amount_collected;
      const expectedAmount = service.commissionable_value * 0.5;

      // Check if this looks like the first 50% payment
      const isFirstHalf = Math.abs(firstEventAmount - expectedAmount) < 0.01;

      if (!isFirstHalf) {
        console.log(`    Service ${service.service_name}: First event doesn't match expected 50% amount`);
        continue;
      }

      // Check if the date needs to be updated
      // For deposit services, collection_date should be close_date, not first_invoice_date
      if (firstEventDate === expectedFirstPaymentDate) {
        console.log(`    Service ${service.service_name}: Already correct (${firstEventDate})`);
        continue;
      }

      console.log(`    Service ${service.service_name}:`);
      console.log(`      Current collection_date: ${firstEventDate}`);
      console.log(`      Updating to close_date: ${expectedFirstPaymentDate}`);
      console.log(`      Note: Commission will still use first_invoice_date (${firstInvoiceDate}) for allocation month`);

      // Update the revenue event
      db.prepare(`
        UPDATE revenue_events
        SET collection_date = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(expectedFirstPaymentDate, firstEvent.id);

      // Delete existing commission entries for this revenue event
      // They will be reprocessed with the correct date
      const commissionEntries = db.prepare(`
        SELECT * FROM commission_entries
        WHERE revenue_event_id = ?
      `).all(firstEvent.id) as any[];

      if (commissionEntries.length > 0) {
        console.log(`      Found ${commissionEntries.length} commission entry/entries to reprocess`);
        
        // Delete existing commission entries
        db.prepare(`
          DELETE FROM commission_entries
          WHERE revenue_event_id = ?
        `).run(firstEvent.id);

        console.log(`      Deleted existing commission entries`);
      }

      // Reprocess the revenue event to create commission entries with correct dates
      try {
        const entryId = await processRevenueEvent(firstEvent.id);
        if (entryId) {
          console.log(`      Reprocessed commission entry with correct dates`);
        }
      } catch (error: any) {
        console.log(`      Warning: Could not reprocess commission entry: ${error.message}`);
        console.log(`      You may need to run rebuild-all-commissions.ts to fix commission entries`);
      }

      updatedCount++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Deals processed: ${dealsWithDeposits.length}`);
  console.log(`Revenue events updated: ${updatedCount}`);
  console.log(`Deals skipped: ${skippedCount}`);
  console.log('\n✅ Fix complete!');
}

fixDepositServiceDates()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });

