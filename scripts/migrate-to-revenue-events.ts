/**
 * Migration script to convert existing commission_entries to revenue_events
 * 
 * This script attempts to reconstruct revenue_events from existing commission_entries
 * by analyzing deal and service data. It links commission_entries to revenue_events
 * and sets accrual_date and payable_date based on the month field.
 * 
 * Usage: npx tsx scripts/migrate-to-revenue-events.ts
 */

import { createClient } from '@/lib/supabase/server';
import { parseISO, format, addDays } from 'date-fns';
import { generateUUID } from '@/lib/utils/uuid';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

interface MigrationReport {
  totalEntries: number;
  migratedEntries: number;
  failedEntries: number;
  skippedEntries: number;
  errors: Array<{ entryId: string; error: string }>;
}

async function migrateCommissionEntriesToRevenueEvents(): Promise<MigrationReport> {
  const report: MigrationReport = {
    totalEntries: 0,
    migratedEntries: 0,
    failedEntries: 0,
    skippedEntries: 0,
    errors: [],
  };

  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    // Get all commission entries that don't have a revenue_event_id
    const entries = db.prepare(`
      SELECT ce.*, d.first_invoice_date, d.bdr_id, d.deal_value, d.is_renewal
      FROM commission_entries ce
      INNER JOIN deals d ON ce.deal_id = d.id
      WHERE ce.revenue_event_id IS NULL
      ORDER BY ce.month ASC
    `).all() as any[];

    report.totalEntries = entries.length;

    // Get commission rules for payout_delay_days
    const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
    const payoutDelayDays = rules?.payout_delay_days || 30;

    for (const entry of entries) {
      try {
        // Skip if deal doesn't have first_invoice_date
        if (!entry.first_invoice_date) {
          report.skippedEntries++;
          continue;
        }

        // Calculate collection date from month field
        const collectionDate = parseISO(entry.month);
        const accrualDate = collectionDate;
        const payableDate = addDays(collectionDate, payoutDelayDays);

        // Try to find matching service for this entry
        const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(entry.deal_id) as any[];
        
        let serviceId: string | null = null;
        let amountCollected = entry.amount;
        let billingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal' = 'one_off';
        let paymentStage: 'invoice' | 'completion' | 'renewal' = 'invoice';

        // If deal has services, try to match
        if (services && services.length > 0) {
          // For now, use the first service or calculate proportionally
          // This is a simplified migration - in practice, you might need more sophisticated matching
          if (services.length === 1) {
            serviceId = services[0].id;
            // Estimate amount_collected from commission amount and rate
            const service = services[0];
            const rate = service.commission_rate || rules?.base_rate || 0.025;
            amountCollected = entry.amount / rate;
            billingType = service.billing_type === 'mrr' ? 'monthly' : 
                         service.billing_type === 'quarterly' ? 'quarterly' : 'one_off';
          } else {
            // Multiple services - use deal value proportionally
            amountCollected = entry.deal_value / (entry.deal_value / entry.amount * (rules?.base_rate || 0.025));
          }
        } else {
          // Legacy deal without services
          const rate = rules?.base_rate || 0.025;
          amountCollected = entry.amount / rate;
        }

        // Handle renewal deals
        if (entry.is_renewal) {
          billingType = 'renewal';
          paymentStage = 'renewal';
        }

        // Create revenue event
        const revenueEventId = generateUUID();
        db.prepare(`
          INSERT INTO revenue_events (
            id, deal_id, service_id, bdr_id, amount_collected,
            collection_date, billing_type, payment_stage, commissionable,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
        `).run(
          revenueEventId,
          entry.deal_id,
          serviceId,
          entry.bdr_id,
          amountCollected,
          format(collectionDate, 'yyyy-MM-dd'),
          billingType,
          paymentStage
        );

        // Update commission entry with revenue_event_id and dates
        db.prepare(`
          UPDATE commission_entries
          SET revenue_event_id = ?,
              accrual_date = ?,
              payable_date = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(
          revenueEventId,
          format(accrualDate, 'yyyy-MM-dd'),
          format(payableDate, 'yyyy-MM-dd'),
          entry.id
        );

        report.migratedEntries++;
      } catch (error: any) {
        report.failedEntries++;
        report.errors.push({
          entryId: entry.id,
          error: error.message || 'Unknown error',
        });
        console.error(`Error migrating entry ${entry.id}:`, error);
      }
    }
  } else {
    // Supabase mode
    const supabase = await createClient();

    // Get all commission entries without revenue_event_id
    const { data: entries, error: entriesError } = await (supabase
      .from('commission_entries')
      .select('*, deals(first_invoice_date, bdr_id, deal_value, is_renewal)')
      .is('revenue_event_id', null) as any);

    if (entriesError) {
      throw new Error(`Failed to fetch commission entries: ${entriesError.message}`);
    }

    report.totalEntries = entries?.length || 0;

    // Get commission rules
    const { data: rules } = await (supabase
      .from('commission_rules')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single() as any);

    const payoutDelayDays = rules?.payout_delay_days || 30;

    for (const entry of entries || []) {
      try {
        const deal = (entry as any).deals;
        if (!deal?.first_invoice_date) {
          report.skippedEntries++;
          continue;
        }

        const collectionDate = parseISO(entry.month);
        const accrualDate = collectionDate;
        const payableDate = addDays(collectionDate, payoutDelayDays);

        // Get services
        const { data: services } = await (supabase
          .from('deal_services')
          .select('*')
          .eq('deal_id', entry.deal_id) as any);

        let serviceId: string | null = null;
        let amountCollected = entry.amount;
        let billingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal' = 'one_off';
        let paymentStage: 'invoice' | 'completion' | 'renewal' = 'invoice';

        if (services && services.length > 0) {
          if (services.length === 1) {
            serviceId = services[0].id;
            const rate = services[0].commission_rate || rules?.base_rate || 0.025;
            amountCollected = entry.amount / rate;
            billingType = services[0].billing_type === 'mrr' ? 'monthly' : 
                         services[0].billing_type === 'quarterly' ? 'quarterly' : 'one_off';
          } else {
            const rate = rules?.base_rate || 0.025;
            amountCollected = entry.amount / rate;
          }
        } else {
          const rate = rules?.base_rate || 0.025;
          amountCollected = entry.amount / rate;
        }

        if (deal.is_renewal) {
          billingType = 'renewal';
          paymentStage = 'renewal';
        }

        // Create revenue event
        const { data: revenueEvent, error: eventError } = await (supabase
          .from('revenue_events')
          .insert({
            deal_id: entry.deal_id,
            service_id: serviceId,
            bdr_id: entry.bdr_id,
            amount_collected: amountCollected,
            collection_date: format(collectionDate, 'yyyy-MM-dd'),
            billing_type: billingType,
            payment_stage: paymentStage,
            commissionable: true,
          })
          .select('id')
          .single() as any);

        if (eventError) {
          throw new Error(`Failed to create revenue event: ${eventError.message}`);
        }

        // Update commission entry
        const { error: updateError } = await (supabase
          .from('commission_entries')
          .update({
            revenue_event_id: revenueEvent.id,
            accrual_date: format(accrualDate, 'yyyy-MM-dd'),
            payable_date: format(payableDate, 'yyyy-MM-dd'),
          })
          .eq('id', entry.id) as any);

        if (updateError) {
          throw new Error(`Failed to update commission entry: ${updateError.message}`);
        }

        report.migratedEntries++;
      } catch (error: any) {
        report.failedEntries++;
        report.errors.push({
          entryId: entry.id,
          error: error.message || 'Unknown error',
        });
        console.error(`Error migrating entry ${entry.id}:`, error);
      }
    }
  }

  return report;
}

// Run migration if called directly
if (require.main === module) {
  migrateCommissionEntriesToRevenueEvents()
    .then((report) => {
      console.log('\n=== Migration Report ===');
      console.log(`Total entries: ${report.totalEntries}`);
      console.log(`Migrated: ${report.migratedEntries}`);
      console.log(`Failed: ${report.failedEntries}`);
      console.log(`Skipped: ${report.skippedEntries}`);
      
      if (report.errors.length > 0) {
        console.log('\nErrors:');
        report.errors.forEach(({ entryId, error }) => {
          console.log(`  Entry ${entryId}: ${error}`);
        });
      }
      
      process.exit(report.failedEntries > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

export { migrateCommissionEntriesToRevenueEvents };



