/**
 * Import or refresh an approved/paid commission report from Excel.
 * Creates or updates a commission batch, snapshot, and fingerprints so
 * the report appears in the Commission UI and its entries are excluded from future reports.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/import-paid-report-from-excel.ts [path] [--status=paid|approved]
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

function normalizePayableDate(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = XLSX.SSF.parse_date_code(raw);
    if (d) {
      const mm = String(d.m).padStart(2, '0');
      const dd = String(d.d).padStart(2, '0');
      return `${d.y}-${mm}-${dd}`;
    }
  }
  const s = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

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
    const payable_date = normalizePayableDate(row[2]);
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

function findExistingBatch(
  db: ReturnType<typeof getLocalDB>,
  runDate: string,
  batchPrefix: string | undefined
): { id: string; status: string } | undefined {
  if (batchPrefix) {
    const byPrefix = db
      .prepare(
        `SELECT id, status FROM commission_batches WHERE id LIKE ? AND status IN ('approved', 'paid') LIMIT 1`
      )
      .get(`${batchPrefix}%`) as { id: string; status: string } | undefined;
    if (byPrefix) return byPrefix;
  }

  const byDate = db
    .prepare(
      `SELECT id, status FROM commission_batches WHERE run_date = ? AND status IN ('approved', 'paid') ORDER BY created_at`
    )
    .all(runDate) as { id: string; status: string }[];

  if (byDate.length === 1) return byDate[0];
  return undefined;
}

function main() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database (USE_LOCAL_DB=true)');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const statusArg = args.find((a) => a.startsWith('--status='))?.split('=')[1];
  const filePath =
    args.find((a) => !a.startsWith('--')) ||
    '/Users/Matty/Downloads/commission-report-2026-02-27-000da1f7 (1).xlsx';

  console.log('\n=== Import Paid Commission Report from Excel ===\n');
  console.log(`File: ${filePath}\n`);

  const rows = parseExcelToExportRows(filePath);
  if (rows.length === 0) {
    console.error('No data rows found in Excel');
    process.exit(1);
  }

  const fileMatch = filePath.match(/commission-report-(\d{4}-\d{2}-\d{2})-([a-f0-9]+)/i);
  const runDate =
    fileMatch?.[1] ??
    rows[0]?.payable_date?.slice(0, 7) + '-01' ??
    new Date().toISOString().slice(0, 10);
  const batchPrefix = fileMatch?.[2];

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

  const existing = findExistingBatch(db, runDate, batchPrefix);
  const batchId = existing?.id ?? generateUUID();
  const status = statusArg ?? existing?.status ?? 'paid';
  const mode = existing ? 'updated' : 'created';

  const writeBatch = db.transaction(() => {
    if (existing) {
      db.prepare(`UPDATE commission_batches SET updated_at = datetime('now') WHERE id = ?`).run(batchId);
      if (statusArg && statusArg !== existing.status) {
        db.prepare(`UPDATE commission_batches SET status = ? WHERE id = ?`).run(statusArg, batchId);
      }
      db.prepare(`DELETE FROM approved_commission_fingerprints WHERE batch_id = ?`).run(batchId);
      db.prepare(`DELETE FROM commission_batch_items WHERE batch_id = ?`).run(batchId);
      const snap = db
        .prepare(`SELECT id FROM commission_batch_snapshots WHERE batch_id = ? LIMIT 1`)
        .get(batchId) as { id: string } | undefined;
      if (snap) {
        db.prepare(`UPDATE commission_batch_snapshots SET snapshot_data = ? WHERE id = ?`).run(
          JSON.stringify(rows),
          snap.id
        );
      } else {
        db.prepare(
          `INSERT INTO commission_batch_snapshots (id, batch_id, snapshot_data) VALUES (?, ?, ?)`
        ).run(generateUUID(), batchId, JSON.stringify(rows));
      }
    } else {
      db.prepare(`
        INSERT INTO commission_batches (id, bdr_id, run_date, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(batchId, bdrId, runDate, status);
      db.prepare(`
        INSERT INTO commission_batch_snapshots (id, batch_id, snapshot_data)
        VALUES (?, ?, ?)
      `).run(generateUUID(), batchId, JSON.stringify(rows));
    }

    const insertFp = db.prepare(`
      INSERT INTO approved_commission_fingerprints (id, bdr_id, deal_id, effective_date, amount, batch_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let fingerprintsCreated = 0;
    const unpaid: string[] = [];

    for (const { row, deal_id, bdr_id } of resolved) {
      const amount =
        parseFloat(String(row.final_invoiced_amount || row.original_commission).replace(/[^0-9.-]/g, '')) || 0;
      if (amount <= 0) continue;

      const effectiveDate = row.payable_date.includes('-') ? row.payable_date.slice(0, 10) : row.payable_date;

      if (deal_id && bdr_id && effectiveDate) {
        insertFp.run(generateUUID(), bdr_id, deal_id, effectiveDate, amount, batchId);
        fingerprintsCreated++;
      } else {
        unpaid.push(`${row.client_name} / ${row.deal} — $${amount} (no matching deal)`);
      }
    }

    return { fingerprintsCreated, unpaid };
  });

  const { fingerprintsCreated, unpaid } = writeBatch();

  console.log(`${mode === 'updated' ? 'Updated' : 'Created'} commission batch: ${batchId}`);
  console.log(`  Status: ${status}`);
  console.log(`  Run date: ${runDate}`);
  console.log(`  BDR ID: ${bdrId}`);
  console.log(`  Rows: ${rows.length}`);
  console.log(`  Fingerprints (paid entries excluded from new reports): ${fingerprintsCreated}`);
  if (unpaid.length > 0) {
    console.log(`  Rows without matching deal (in report but not fingerprinted):`);
    unpaid.forEach((u) => console.log(`    - ${u}`));
  }
  console.log('\nDone. Run sync-entries-from-approved-batches.ts to link live entries.\n');
}

main();
