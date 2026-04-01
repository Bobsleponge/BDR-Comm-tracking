/**
 * Diagnose why Miami Vineyard Feb 2026 appears in new reports despite being paid.
 * Run: USE_LOCAL_DB=true npx tsx scripts/diagnose-miami-vineyard.ts
 */

import { getLocalDB } from '../lib/db/local-db';

function main() {
  const db = getLocalDB();

  // Find Miami Vineyard deal(s) - handle variations in name
  const deals = db.prepare(`
    SELECT id, client_name, bdr_id, status, cancellation_date
    FROM deals
    WHERE LOWER(client_name) LIKE '%miami%vineyard%'
       OR LOWER(client_name) LIKE '%vineyard%community%'
       OR LOWER(client_name) LIKE '%miami vineyard%'
  `).all() as Array<{ id: string; client_name: string; bdr_id: string; status: string; cancellation_date: string | null }>;

  if (deals.length === 0) {
    console.log('No deals found matching "Miami Vineyard". Searching for partial matches...');
    const all = db.prepare(`SELECT id, client_name, bdr_id FROM deals WHERE LOWER(client_name) LIKE '%vineyard%' OR LOWER(client_name) LIKE '%miami%'`).all() as any[];
    console.log('Deals with "vineyard" or "miami":', all.map((d) => `${d.client_name} (${d.id})`));
    return;
  }

  console.log('\n=== Miami Vineyard Deal(s) ===\n');
  for (const deal of deals) {
    console.log(`Deal: ${deal.client_name}`);
    console.log(`  ID: ${deal.id}`);
    console.log(`  BDR: ${deal.bdr_id}`);
    console.log(`  Status: ${deal.status}`);

    // Commission entries for this deal (Feb 2026)
    const entries = db.prepare(`
      SELECT ce.id, ce.deal_id, ce.month, ce.payable_date, ce.accrual_date, ce.amount, ce.status, ce.invoiced_batch_id,
             substr(COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01'), 1, 7) as month_key
      FROM commission_entries ce
      WHERE ce.deal_id = ?
      AND (ce.month LIKE '2026-02%' OR ce.payable_date LIKE '2026-02%' OR ce.accrual_date LIKE '2026-02%')
    `).all(deal.id) as any[];

    console.log(`\n  Commission entries (Feb 2026):`);
    for (const e of entries) {
      console.log(`    - ${e.id.slice(0, 8)}... month=${e.month} pay=${e.payable_date} accr=${e.accrual_date} amt=$${e.amount} status=${e.status} batch=${e.invoiced_batch_id?.slice(0, 8) ?? 'null'} month_key=${e.month_key}`);
    }

    // Fingerprints for this deal
    const fps = db.prepare(`
      SELECT id, bdr_id, deal_id, effective_date, amount, batch_id,
             substr(effective_date, 1, 7) as month_key
      FROM approved_commission_fingerprints
      WHERE deal_id = ?
    `).all(deal.id) as any[];

    console.log(`\n  Approved fingerprints for this deal:`);
    if (fps.length === 0) {
      console.log('    *** NONE - This is why it appears in new reports! ***');
    } else {
      for (const fp of fps) {
        console.log(`    - ${fp.effective_date} amt=$${fp.amount} batch=${fp.batch_id?.slice(0, 8)} month_key=${fp.month_key}`);
      }
    }

    // All fingerprints for this BDR (for comparison)
    const bdrFps = db.prepare(`
      SELECT deal_id, effective_date, substr(effective_date, 1, 7) as month_key
      FROM approved_commission_fingerprints
      WHERE bdr_id = ?
    `).all(deal.bdr_id) as any[];

    console.log(`\n  Would entry month_key "${entries[0]?.month_key}" match any fingerprint?`);
    const monthKey = entries[0]?.month_key;
    if (monthKey) {
      const match = fps.some((fp) => fp.month_key === monthKey);
      console.log(`    Match in deal fingerprints: ${match}`);
      const matchBdr = bdrFps.some((fp) => fp.deal_id === deal.id && fp.month_key === monthKey);
      console.log(`    Match (deal+month) in BDR fingerprints: ${matchBdr}`);
    }

    // Approved/paid batches that might have had this
    const approvedBatches = db.prepare(`
      SELECT cb.id, cb.run_date, cb.status
      FROM commission_batches cb
      WHERE cb.bdr_id = ? AND cb.status IN ('approved', 'paid')
      ORDER BY cb.run_date DESC
      LIMIT 5
    `).all(deal.bdr_id) as any[];

    console.log(`\n  Recent approved/paid batches for BDR:`);
    for (const b of approvedBatches) {
      const itemCount = db.prepare('SELECT COUNT(*) as c FROM commission_batch_items WHERE batch_id = ?').get(b.id) as { c: number };
      console.log(`    ${b.id.slice(0, 8)}... ${b.run_date} ${b.status} (${itemCount?.c ?? 0} items)`);
    }

    console.log('\n---\n');
  }

  console.log('\n=== RECOMMENDATION ===\n');
  const deal = deals[0];
  const entries = db.prepare(`
    SELECT ce.id, ce.amount, ce.payable_date, ce.accrual_date, ce.month
    FROM commission_entries ce
    WHERE ce.deal_id = ?
    AND (ce.month LIKE '2026-02%' OR ce.payable_date LIKE '2026-02%' OR ce.accrual_date LIKE '2026-02%')
    LIMIT 1
  `).all(deal.id) as any[];

  const fps = db.prepare('SELECT 1 FROM approved_commission_fingerprints WHERE deal_id = ? AND substr(effective_date, 1, 7) = ?').get(deal.id, '2026-02') as { '1': number } | undefined;

  if (!fps && entries.length > 0) {
    console.log('No fingerprint exists for Miami Vineyard Feb 2026.');
    console.log('Run this to add one (fixes the duplicate):');
    console.log('');
    console.log(`  USE_LOCAL_DB=true npx tsx scripts/diagnose-miami-vineyard.ts --fix`);
    console.log('');
  }
}

// Check for --fix flag
const fix = process.argv.includes('--fix');
if (fix) {
  const db = getLocalDB();
  const { generateUUID } = require('../lib/utils/uuid');

  const deals = db.prepare(`
    SELECT id, client_name, bdr_id
    FROM deals
    WHERE LOWER(client_name) LIKE '%miami%vineyard%'
       OR LOWER(client_name) LIKE '%vineyard%community%'
       OR LOWER(client_name) LIKE '%miami vineyard%'
  `).all() as Array<{ id: string; client_name: string; bdr_id: string }>;

  if (deals.length === 0) {
    console.error('Deal not found');
    process.exit(1);
  }

  const deal = deals[0];
  const entry = db.prepare(`
    SELECT id, amount, payable_date, accrual_date, month
    FROM commission_entries
    WHERE deal_id = ?
    AND (month LIKE '2026-02%' OR payable_date LIKE '2026-02%' OR accrual_date LIKE '2026-02%')
    LIMIT 1
  `).get(deal.id) as { id: string; amount: number; payable_date: string | null; accrual_date: string | null; month: string | null } | undefined;

  const existingFp = db.prepare(`
    SELECT 1 FROM approved_commission_fingerprints
    WHERE deal_id = ? AND bdr_id = ? AND substr(effective_date, 1, 7) = '2026-02'
  `).get(deal.id, deal.bdr_id);

  if (existingFp) {
    console.log('Fingerprint for Miami Vineyard Feb 2026 already exists. Nothing to do.');
    process.exit(0);
  }

  // Need a batch_id - use most recent paid batch for this BDR
  const batch = db.prepare(`
    SELECT id FROM commission_batches
    WHERE bdr_id = ? AND status IN ('approved', 'paid')
    ORDER BY run_date DESC
    LIMIT 1
  `).get(deal.bdr_id) as { id: string } | undefined;

  if (!batch) {
    console.error('No approved/paid batch found for this BDR. Cannot add fingerprint.');
    process.exit(1);
  }

  const effectiveDate = entry?.payable_date || entry?.accrual_date || (entry?.month ? `${entry.month}-01` : null) || '2026-02-01';
  const amount = entry?.amount ?? 0;

  db.prepare(`
    INSERT INTO approved_commission_fingerprints (id, bdr_id, deal_id, effective_date, amount, batch_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(generateUUID(), deal.bdr_id, deal.id, effectiveDate, amount, batch.id);

  console.log(`Added fingerprint: ${deal.client_name} Feb 2026 (deal=${deal.id.slice(0, 8)}, effective_date=${effectiveDate}, amount=$${amount})`);
  console.log('Generate a new report - Miami Vineyard should no longer appear.');
  process.exit(0);
}

main();
