/**
 * FIX SCRIPT: Create missing revenue events and commission entries
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/fix-missing-commission-entries.ts [--dry-run]
 *
 * Reprocesses all closed-won deals that have verification issues:
 * - Services with no revenue events
 * - Services with fewer revenue events than expected (e.g. deposit second half, MRR months)
 *
 * Uses same logic as the Reprocess API: delete existing rev events + commission entries,
 * recreate revenue events from current deal/service data, process all events to create entries.
 *
 * Use --dry-run to see which deals would be fixed without making changes.
 */

import { getLocalDB } from '../lib/db/local-db';
import { createRevenueEventsForDeal, processRevenueEvent } from '../lib/commission/revenue-events-local';

interface DealRow {
  id: string;
  client_name: string;
  first_invoice_date: string | null;
  is_renewal?: number | boolean;
  original_deal_value?: number | null;
}

interface ServiceRow {
  id: string;
  service_name: string;
  billing_type: string;
  contract_months: number;
  contract_quarters: number;
  completion_date: string | null;
  is_renewal?: number | boolean;
}

function getExpectedRevenueEventCount(service: ServiceRow, deal?: DealRow): number {
  const bt = (service.billing_type || '').toLowerCase();
  if (bt === 'deposit') return service.completion_date ? 2 : 1; // Payment structure regardless of renewal
  if (bt === 'paid_on_completion') return 1;
  const isRenewal =
    service.is_renewal === 1 ||
    service.is_renewal === true ||
    (deal && (deal.is_renewal === 1 || deal.is_renewal === true) && Number(deal.original_deal_value ?? 0) > 0);
  if (isRenewal) return 1; // Renewal (one_off/mrr/quarterly): one-time uplift only
  if (bt === 'mrr') return service.contract_months ?? 12;
  if (bt === 'quarterly') return service.contract_quarters ?? 4;
  return 1;
}

function getDealsNeedingReprocess(): Array<{ dealId: string; clientName: string; reason: string }> {
  const db = getLocalDB();

  const deals = db.prepare(`
    SELECT id, client_name, first_invoice_date, is_renewal, original_deal_value
    FROM deals
    WHERE status = 'closed-won' AND cancellation_date IS NULL
    ORDER BY close_date
  `).all() as DealRow[];

  const needsReprocess = new Map<string, string>();

  for (const deal of deals) {
    const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(deal.id) as ServiceRow[];

    for (const service of services) {
      const revenueEvents = db.prepare(`
        SELECT id FROM revenue_events WHERE deal_id = ? AND service_id = ? AND commissionable = 1
      `).all(deal.id, service.id) as Array<{ id: string }>;

      const expected = getExpectedRevenueEventCount(service, deal);
      const actual = revenueEvents.length;

      if (actual < expected) {
        const reason = actual === 0
          ? `no revenue events (expected ${expected})`
          : `${actual}/${expected} revenue events`;
        const existing = needsReprocess.get(deal.id);
        needsReprocess.set(deal.id, existing ? `${existing}; ${reason}` : `${deal.client_name}: ${reason}`);
      }
    }
  }

  return Array.from(needsReprocess.entries()).map(([dealId, msg]) => {
    const deal = deals.find((d) => d.id === dealId);
    return { dealId, clientName: deal?.client_name ?? 'Unknown', reason: msg };
  });
}

async function reprocessDeal(dealId: string): Promise<{ events: number; entries: number }> {
  const db = getLocalDB();

  // Do not delete entries that are in approved/paid batches - prevents double-counting in new reports
  const inApprovedBatch = db.prepare(`
    SELECT 1 FROM commission_entries ce
    JOIN commission_batch_items cbi ON cbi.commission_entry_id = ce.id
    JOIN commission_batches cb ON cbi.batch_id = cb.id
    WHERE ce.deal_id = ? AND cb.status IN ('approved', 'paid')
    LIMIT 1
  `).get(dealId) as { '1': number } | undefined;
  if (inApprovedBatch) {
    throw new Error('SKIP_APPROVED: Deal has entries in an approved/paid report');
  }

  db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(dealId);
  db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);

  await createRevenueEventsForDeal(dealId);

  const revenueEvents = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ?')
    .all(dealId) as Array<{ id: string }>;

  for (const event of revenueEvents) {
    await processRevenueEvent(event.id);
  }

  const entries = db.prepare('SELECT COUNT(*) as c FROM commission_entries WHERE deal_id = ?')
    .get(dealId) as { c: number };

  return { events: revenueEvents.length, entries: entries.c };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('='.repeat(70));
  console.log('FIX MISSING COMMISSION ENTRIES');
  console.log('='.repeat(70));
  if (dryRun) {
    console.log('\n[DRY RUN - no changes will be made]\n');
  }

  const toFix = getDealsNeedingReprocess();
  console.log(`Deals needing reprocess: ${toFix.length}\n`);

  if (toFix.length === 0) {
    console.log('No deals need reprocessing. All commission entries are in sync.');
    return;
  }

  toFix.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.clientName} (${d.dealId})`);
    console.log(`     Reason: ${d.reason}`);
  });

  if (dryRun) {
    console.log('\nRun without --dry-run to fix these deals.');
    return;
  }

  console.log('\nReprocessing...\n');

  let fixed = 0;
  let errors = 0;

  for (const d of toFix) {
    try {
      const { events, entries } = await reprocessDeal(d.dealId);
      console.log(`  ✓ ${d.clientName}: ${events} revenue events → ${entries} commission entries`);
      fixed++;
    } catch (err: any) {
      if (err.message?.startsWith('SKIP_APPROVED:')) {
        console.log(`  ⊘ ${d.clientName}: skipped (entries in approved report)`);
      } else {
        console.error(`  ✗ ${d.clientName}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${errors} errors.`);
  console.log('Run verify-commission-entries.ts to confirm.');
}

main().catch(console.error);
