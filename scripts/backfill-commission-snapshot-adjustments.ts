/**
 * Rebuild commission_batch_snapshots with UI-only adjustment fields
 * (commission_entry_id, change_summary, adjusted_at, is_adjusted, ...)
 * using current commission_batch_items + commission_entries joins.
 *
 * Use when snapshots were saved as plain ExportRow[] before enrichment shipped.
 *
 * Limits:
 * - Batches whose batch_items were CASCADE-deleted cannot be reconstructed here
 *   (no stable commission_entry_id). Those are skipped.
 * - Imported paid-only batches without items are skipped (see import-paid-report-from-excel).
 *
 * SQLite only (matches local-db workflow).
 *
 * Optional: only one batch
 *   BATCH_ID=<uuid> APPLY=1 npx tsx scripts/backfill-commission-snapshot-adjustments.ts
 *
 *   npx tsx scripts/backfill-commission-snapshot-adjustments.ts
 *   APPLY=1 npx tsx scripts/backfill-commission-snapshot-adjustments.ts
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getLocalDB } from '../lib/db/local-db';
import { buildCommissionSnapshotRows } from '../lib/commission/export-rows';

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(resolve(process.cwd(), '.env.local'));

const APPLY = process.env.APPLY === '1' || process.env.APPLY === 'true';
const BATCH_ID_FILTER = (process.env.BATCH_ID || '').trim() || null;

const SNAPSHOT_ITEMS_SQL = `
  SELECT
    cbi.commission_entry_id,
    cbi.adjustment_note,
    cbi.updated_at as batch_item_updated_at,
    cbi.override_amount,
    cbi.override_payment_date,
    cbi.override_commission_rate,
    ce.amount as original_amount,
    ce.payable_date,
    ce.accrual_date,
    d.client_name,
    d.service_type,
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
  LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
  WHERE cbi.batch_id = ?
  ORDER BY COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01'), cbi.commission_entry_id
`;

function main() {
  const db = getLocalDB();

  const snaps = db
    .prepare(
      `
    SELECT DISTINCT s.batch_id, cb.status as batch_status
    FROM commission_batch_snapshots s
    JOIN commission_batches cb ON cb.id = s.batch_id
  `
    )
    .all() as Array<{ batch_id: string; batch_status: string }>;

  console.log('\n=== backfill commission snapshot adjustments ===\n');
  console.log('APPLY:', APPLY);
  console.log('BATCH_ID filter:', BATCH_ID_FILTER || '(all)');
  console.log('Snapshots:', snaps.length);

  let updated = 0;
  let skippedNoItems = 0;
  let skippedMismatch = 0;

  const countItems = db.prepare('SELECT COUNT(*) as n FROM commission_batch_items WHERE batch_id = ?');
  const selItems = db.prepare(SNAPSHOT_ITEMS_SQL);
  const updateSnap = db.prepare('UPDATE commission_batch_snapshots SET snapshot_data = ? WHERE batch_id = ?');

  for (const { batch_id, batch_status } of snaps) {
    if (BATCH_ID_FILTER && batch_id !== BATCH_ID_FILTER) continue;
    const itemCount = (countItems.get(batch_id) as { n: number }).n;
    if (itemCount === 0) {
      skippedNoItems++;
      console.log(`  skip (no batch_items) ${batch_id.slice(0, 8)}… status=${batch_status}`);
      continue;
    }

    const snapshotRow = db
      .prepare('SELECT snapshot_data FROM commission_batch_snapshots WHERE batch_id = ?')
      .get(batch_id) as { snapshot_data: string } | undefined;
    if (!snapshotRow?.snapshot_data) continue;

    let existingLen = 0;
    try {
      const parsed = JSON.parse(snapshotRow.snapshot_data);
      existingLen = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      console.log(`  skip (bad JSON) ${batch_id.slice(0, 8)}`);
      skippedMismatch++;
      continue;
    }

    const snapshotItems = selItems.all(batch_id) as any[];
    if (snapshotItems.length !== existingLen && existingLen > 0) {
      console.log(
        `  warn ${batch_id.slice(0, 8)}… row count differs: snapshot=${existingLen} live_items=${snapshotItems.length} — overwriting with live_items`
      );
    }

    const rows = buildCommissionSnapshotRows(snapshotItems);
    const json = JSON.stringify(rows);

    const adjustedLines = rows.filter((r: { is_adjusted?: boolean }) => r.is_adjusted).length;
    console.log(
      `  ${batch_id.slice(0, 8)}… status=${batch_status} rows=${rows.length} adjusted_lines=${adjustedLines}${APPLY ? ' → WRITE' : ' (dry-run)'}`
    );

    if (APPLY) updateSnap.run(json, batch_id);
    updated++;
  }

  console.log('\nDone.');
  console.log('  batches processed (had items):', updated);
  console.log('  skipped (zero batch_items):', skippedNoItems);
  console.log('  skipped (bad JSON etc.):', skippedMismatch);
  if (!APPLY) console.log('\nRe-run with APPLY=1 to update snapshot_data.\n');
  else console.log('');
}

main();
