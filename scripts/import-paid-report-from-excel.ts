/**
 * Import an approved/paid commission report from Excel.
 * Creates a commission batch (status=paid), snapshot, and fingerprints so
 * the report appears in the Commission UI and its entries are excluded from future reports.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/import-paid-report-from-excel.ts [path]
 *
 * Example:
 *   npx tsx scripts/import-paid-report-from-excel.ts "/Users/Matty/Downloads/commission-report-2026-02-27-000da1f7 (1).xlsx"
 */

import * as XLSX from 'xlsx';
import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';
import type { ExportRow } from '../lib/commission/export-rows';

const USE_LOCAL_DB =
  process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

function parseExcelToExportRows(filePath: string): ExportRow[] {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });

  const rows: ExportRow[] = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i] as string[];
    if (!Array.isArray(row) || row.length < 3) continue;

    const firstCell = String(row[0] ?? '').trim();
    if (!firstCell || firstCell === 'Client') continue;
    if (firstCell === 'TOTAL') break; // End of data
    if (firstCell.includes('—') && firstCell.includes('$')) continue; // Month header

    const client_name = firstCell;
    const deal = String(row[1] ?? '').trim() || '';
    const payable_date = String(row[2] ?? '').trim().slice(0, 10);
    const amount_claimed_on = String(row[3] ?? '').trim();
    const is_renewal = String(row[4] ?? '').trim() === 'Yes' ? 'Yes' : 'No';
    const previous_deal_amount = String(row[5] ?? '').trim();
    const new_deal_amount = String(row[6] ?? '').trim();
    const commission_pct = String(row[7] ?? '').trim();
    const original_commission = String(row[8] ?? '').trim();
    const override_amount = String(row[9] ?? '').trim();
    const final_invoiced_amount = String(row[10] ?? '').trim();

    if (!client_name || !payable_date) continue;

    rows.push({
      client_name,
      deal,
      payable_date,
      amount_claimed_on,
      is_renewal,
      previous_deal_amount,
      new_deal_amount,
      commission_pct,
      original_commission,
      override_amount,
      final_invoiced_amount,
    });
  }
  return rows;
}

function main() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database (USE_LOCAL_DB=true)');
    process.exit(1);
  }

  const filePath =
    process.argv[2] || '/Users/Matty/Downloads/commission-report-2026-02-27-000da1f7 (1).xlsx';

  console.log('\n=== Import Paid Commission Report from Excel ===\n');
  console.log(`File: ${filePath}\n`);

  const rows = parseExcelToExportRows(filePath);
  if (rows.length === 0) {
    console.error('No data rows found in Excel');
    process.exit(1);
  }

  // Extract run_date from filename: commission-report-2026-02-27-000da1f7.xlsx
  const match = filePath.match(/commission-report-(\d{4}-\d{2}-\d{2})/i);
  const runDate = match?.[1] ?? rows[0]?.payable_date?.slice(0, 7) + '-01' ?? new Date().toISOString().slice(0, 10);

  const db = getLocalDB();

  // Resolve bdr_id and deal_id for each row (match client + service name)
  const resolveDealWithService = db.prepare(`
    SELECT d.id as deal_id, d.bdr_id
    FROM deals d
    JOIN deal_services ds ON ds.deal_id = d.id AND trim(ds.service_name) = trim(?)
    WHERE trim(d.client_name) = trim(?)
      AND d.status = 'closed-won'
      AND d.cancellation_date IS NULL
    LIMIT 1
  `);

  const resolveDealByClientOnly = db.prepare(`
    SELECT id as deal_id, bdr_id FROM deals
    WHERE trim(client_name) = trim(?) AND status = 'closed-won' AND cancellation_date IS NULL
    LIMIT 1
  `);

  let bdrId: string | null = null;
  const resolved: Array<{ row: ExportRow; deal_id: string | null; bdr_id: string | null }> = [];

  for (const row of rows) {
    let r: { deal_id: string; bdr_id: string } | undefined;
    if (row.deal) {
      r = resolveDealWithService.get(row.deal, row.client_name) as { deal_id: string; bdr_id: string } | undefined;
    }
    if (!r) {
      r = resolveDealByClientOnly.get(row.client_name) as { deal_id: string; bdr_id: string } | undefined;
    }
    if (r) {
      bdrId = bdrId ?? r.bdr_id;
      resolved.push({ row, deal_id: r.deal_id, bdr_id: r.bdr_id });
    } else {
      resolved.push({ row, deal_id: null, bdr_id: null });
    }
  }

  if (!bdrId) {
    console.error('Could not resolve bdr_id from any row. Check that clients exist in deals.');
    process.exit(1);
  }

  const batchId = generateUUID();
  const snapshotId = generateUUID();

  // 1. Create commission batch (status=paid)
  db.prepare(`
    INSERT INTO commission_batches (id, bdr_id, run_date, status, created_at, updated_at)
    VALUES (?, ?, ?, 'paid', datetime('now'), datetime('now'))
  `).run(batchId, bdrId, runDate);

  // 2. Create snapshot (report rows for display)
  db.prepare(`
    INSERT INTO commission_batch_snapshots (id, batch_id, snapshot_data)
    VALUES (?, ?, ?)
  `).run(snapshotId, batchId, JSON.stringify(rows));

  // 3. Create fingerprints (exclude these from future eligible entries)
  const insertFp = db.prepare(`
    INSERT INTO approved_commission_fingerprints (id, bdr_id, deal_id, effective_date, amount, batch_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let fingerprintsCreated = 0;
  const unpaid: string[] = [];

  for (const { row, deal_id, bdr_id } of resolved) {
    const amount = parseFloat(String(row.final_invoiced_amount || row.original_commission).replace(/[^0-9.-]/g, '')) || 0;
    if (amount <= 0) continue;

    const effectiveDate = row.payable_date.includes('-') ? row.payable_date.slice(0, 10) : row.payable_date;

    if (deal_id && bdr_id && effectiveDate) {
      insertFp.run(generateUUID(), bdr_id, deal_id, effectiveDate, amount, batchId);
      fingerprintsCreated++;
    } else {
      unpaid.push(`${row.client_name} / ${row.deal} — $${amount} (no matching deal)`);
    }
  }

  console.log(`Created commission batch: ${batchId}`);
  console.log(`  Status: paid`);
  console.log(`  Run date: ${runDate}`);
  console.log(`  BDR ID: ${bdrId}`);
  console.log(`  Rows: ${rows.length}`);
  console.log(`  Fingerprints (paid entries excluded from new reports): ${fingerprintsCreated}`);
  if (unpaid.length > 0) {
    console.log(`  Rows without matching deal (in report but not fingerprinted):`);
    unpaid.forEach((u) => console.log(`    - ${u}`));
  }
  console.log('\nDone. Report is visible in Commission > Batches as a paid report.\n');
}

main();
