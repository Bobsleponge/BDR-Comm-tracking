/**
 * Diagnose why Sharpear Capital deals are not appearing in commission reports.
 * Run: USE_LOCAL_DB=true npx tsx scripts/diagnose-sharpear-capital.ts
 */

import { getLocalDB } from '../lib/db/local-db';

function main() {
  const db = getLocalDB();

  const deals = db.prepare(`
    SELECT id, client_name, bdr_id, status, cancellation_date, close_date
    FROM deals
    WHERE LOWER(client_name) LIKE '%sharpear%'
       OR LOWER(client_name) LIKE '%sharpear capital%'
  `).all() as Array<{
    id: string;
    client_name: string;
    bdr_id: string;
    status: string;
    cancellation_date: string | null;
    close_date: string | null;
  }>;

  if (deals.length === 0) {
    console.log('No deals found matching "Sharpear" or "Sharpear Capital".');
    const partial = db
      .prepare(`SELECT id, client_name FROM deals WHERE LOWER(client_name) LIKE '%sharpe%'`)
      .all() as any[];
    if (partial.length > 0) {
      console.log('Partial matches:', partial.map((d) => d.client_name));
    }
    return;
  }

  console.log('\n=== Sharpear Capital Deal(s) ===\n');
  for (const deal of deals) {
    console.log(`Deal: ${deal.client_name}`);
    console.log(`  ID: ${deal.id}`);
    console.log(`  BDR: ${deal.bdr_id}`);
    console.log(`  Status: ${deal.status}`);
    console.log(`  Cancellation: ${deal.cancellation_date ?? 'none'}`);
    console.log(`  Close date: ${deal.close_date ?? 'none'}`);

    // Commission entries for this deal
    const entries = db
      .prepare(
        `
      SELECT ce.id, ce.month, ce.payable_date, ce.accrual_date, ce.amount, ce.status, ce.invoiced_batch_id, ce.bdr_id,
             substr(COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01'), 1, 7) as month_key
      FROM commission_entries ce
      WHERE ce.deal_id = ?
    `
      )
      .all(deal.id) as any[];

    console.log(`\n  Commission entries: ${entries.length}`);
    if (entries.length === 0) {
      console.log('  *** NO ENTRIES - Check if revenue_events exist for this deal ***');
      const revEvents = db
        .prepare('SELECT id, collection_date, amount_collected, billing_type, service_id FROM revenue_events WHERE deal_id = ?')
        .all(deal.id) as any[];
      console.log(`  Revenue events: ${revEvents.length}`);
      for (const re of revEvents) {
        console.log(`    - ${re.id?.slice(0, 8)}... collected=$${re.amount_collected} ${re.collection_date} ${re.billing_type}`);
      }
    } else {
      const today = new Date().toISOString().slice(0, 10);
      for (const e of entries) {
        const effectiveDate = e.payable_date || e.accrual_date || (e.month ? `${e.month}-01` : null);
        const isDue = effectiveDate && effectiveDate <= today;
        const inEligibleStatus = ['payable', 'accrued', 'pending'].includes(e.status);
        const notInBatch = !e.invoiced_batch_id || e.invoiced_batch_id === '';

        console.log(`    - ${e.id?.slice(0, 8)}... month=${e.month} pay=${e.payable_date} status=${e.status} amt=$${e.amount}`);
        console.log(`      Due: ${isDue} | Eligible status: ${inEligibleStatus} | Not in batch: ${notInBatch}`);
      }
    }

    // Fingerprints (would exclude from eligible)
    const fps = db
      .prepare(
        `
      SELECT effective_date, substr(effective_date, 1, 7) as month_key, batch_id
      FROM approved_commission_fingerprints
      WHERE deal_id = ?
    `
      )
      .all(deal.id) as any[];

    if (fps.length > 0) {
      console.log(`\n  Approved fingerprints (excludes from reports): ${fps.length}`);
      fps.forEach((fp) => console.log(`    - ${fp.effective_date} batch=${fp.batch_id?.slice(0, 8)}`));
    }
    console.log('\n---\n');
  }
}

main();
