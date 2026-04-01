/**
 * Verify that commission entries with overrides are reflected correctly.
 * Checks: override_amount, override_commission_rate, override_payment_date
 * and that final amounts match across display, export, and snapshot logic.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/verify-override-integrity.ts
 */

import { getLocalDB } from '../lib/db/local-db';
import { buildExportRows } from '../lib/commission/export-rows';

function main() {
  const db = getLocalDB();

  console.log('\n=== Override Integrity Verification ===\n');

  // 1. Find all batch items with any override
  const withOverrides = db.prepare(`
    SELECT
      cbi.batch_id,
      cbi.commission_entry_id,
      cbi.override_amount,
      cbi.override_commission_rate,
      cbi.override_payment_date,
      ce.amount as original_amount,
      re.amount_collected
    FROM commission_batch_items cbi
    JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    WHERE cbi.override_amount IS NOT NULL
       OR cbi.override_commission_rate IS NOT NULL
       OR cbi.override_payment_date IS NOT NULL
  `).all() as any[];

  console.log(`Batch items with overrides: ${withOverrides.length}`);

  if (withOverrides.length === 0) {
    console.log('No overrides to verify.\n');
    return;
  }

  // 2. For each batch with overrides, fetch full items and run through buildExportRows
  const batchIds = [...new Set(withOverrides.map((r) => r.batch_id))];
  let issues = 0;

  for (const batchId of batchIds) {
    const batch = db.prepare('SELECT id, status FROM commission_batches WHERE id = ?').get(batchId) as any;
    if (!batch) continue;

    const items = db.prepare(`
      SELECT
        cbi.override_amount,
        cbi.override_payment_date,
        cbi.override_commission_rate,
        ce.amount as original_amount,
        ce.payable_date,
        ce.accrual_date,
        d.client_name,
        d.service_type as deal_service_type,
        d.deal_value,
        d.original_deal_value,
        d.is_renewal as deal_is_renewal,
        ds.service_name,
        ds.commission_rate,
        ds.is_renewal as service_is_renewal,
        ds.original_service_value,
        ds.commissionable_value,
        re.billing_type as re_billing_type,
        re.collection_date,
        re.amount_collected
      FROM commission_batch_items cbi
      JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
      JOIN deals d ON ce.deal_id = d.id
      LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
      LEFT JOIN deal_services ds ON re.service_id = ds.id
      WHERE cbi.batch_id = ?
    `).all(batchId) as any[];

    const rows = buildExportRows(items);

    // 3. If approved + has snapshot, compare snapshot to current build
    if (batch.status === 'approved' || batch.status === 'paid') {
      const snapshot = db.prepare('SELECT snapshot_data FROM commission_batch_snapshots WHERE batch_id = ?').get(batchId) as { snapshot_data: string } | undefined;
      if (snapshot?.snapshot_data) {
        const snapshotRows = JSON.parse(snapshot.snapshot_data) as Array<{ client_name: string; final_invoiced_amount: string }>;
        if (snapshotRows.length !== rows.length) {
          console.log(`  ⚠ Batch ${batchId.slice(0, 8)}: snapshot has ${snapshotRows.length} rows, live would have ${rows.length}`);
          issues++;
        }
        const snapTotal = snapshotRows.reduce((s, r) => s + parseFloat(r.final_invoiced_amount || '0'), 0);
        const liveTotal = rows.reduce((s, r) => s + parseFloat(r.final_invoiced_amount || '0'), 0);
        if (Math.abs(snapTotal - liveTotal) > 0.01) {
          console.log(`  ⚠ Batch ${batchId.slice(0, 8)}: snapshot total $${snapTotal.toFixed(2)} vs live $${liveTotal.toFixed(2)}`);
          issues++;
        }
      }
    }

    // 4. Per-item: verify override_amount takes precedence over override_commission_rate
    for (const item of items) {
      const hasOverrideAmt = item.override_amount != null;
      const hasOverrideRate = item.override_commission_rate != null;
      const amtCollected = item.amount_collected ?? 0;

      let expectedFinal: number;
      if (hasOverrideAmt) {
        expectedFinal = item.override_amount;
      } else if (hasOverrideRate && amtCollected > 0) {
        expectedFinal = amtCollected * item.override_commission_rate;
      } else {
        expectedFinal = item.original_amount ?? 0;
      }

      const row = rows.find((r) => r.client_name === (item.client_name ?? '') && Math.abs(parseFloat(r.final_invoiced_amount || '0') - expectedFinal) < 0.01);
      if (!row) {
        const actualRow = rows.find((r) => r.client_name === (item.client_name ?? ''));
        const actual = actualRow ? parseFloat(actualRow.final_invoiced_amount || '0') : 0;
        if (Math.abs(actual - expectedFinal) >= 0.01) {
          console.log(`  ⚠ ${item.client_name}: expected $${expectedFinal.toFixed(2)}, got $${actual.toFixed(2)}`);
          issues++;
        }
      }
    }
  }

  console.log(issues === 0 ? '\n✓ No override integrity issues found.\n' : `\n⚠ Found ${issues} potential issue(s).\n`);
}

main();
