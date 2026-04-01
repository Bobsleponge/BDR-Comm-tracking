/**
 * Import approved commission entries from Excel report files into approved_commission_fingerprints.
 * Use when report data was lost (e.g. reprocessing CASCADE-deleted batch items) but you have
 * the original Excel exports.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/import-approved-from-excel.ts [path1] [path2] ...
 *
 * Example:
 *   npx tsx scripts/import-approved-from-excel.ts \
 *     "/Users/Matty/Downloads/commission-report-2026-02-27-000da1f7 (1).xlsx" \
 *     "/Users/Matty/Downloads/commission-report-2026-02-19-6d0f8bd8 (5).xlsx"
 */

import * as XLSX from 'xlsx';
import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';

const DEFAULT_FILES = [
  '/Users/Matty/Downloads/commission-report-2026-02-27-000da1f7 (1).xlsx',
  '/Users/Matty/Downloads/commission-report-2026-02-19-6d0f8bd8 (5).xlsx',
];

interface ParsedRow {
  client_name: string;
  payable_date: string;
  final_invoiced_amount: number;
  deal?: string;
}

function parseExcelFile(filePath: string): { runDate: string; batchIdPrefix: string; rows: ParsedRow[] } {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });

  // Extract run_date and batch id from filename: commission-report-2026-02-27-000da1f7.xlsx
  const match = filePath.match(/commission-report-(\d{4}-\d{2}-\d{2})-([a-f0-9]+)/i);
  const runDate = match?.[1] ?? '';
  const batchIdPrefix = match?.[2] ?? '';

  const rows: ParsedRow[] = [];
  const headers = ['Client', 'Deal', 'Payable date', 'Amount claimed on', 'Is renewal', 'Previous deal amount', 'New deal amount', 'Commission %', 'Original commission', 'Override amount', 'Final invoiced amount'];

  for (let i = 0; i < data.length; i++) {
    const row = data[i] as string[];
    if (!Array.isArray(row) || row.length < 3) continue;

    const firstCell = String(row[0] ?? '').trim();
    // Skip header and month headings (e.g. "January 2026 — $123.45")
    if (!firstCell || firstCell === 'Client' || firstCell === 'TOTAL') continue;
    if (firstCell.includes('—') && firstCell.includes('$')) continue;

    const client_name = firstCell;
    const payable_date = String(row[2] ?? '').trim();
    const final_invoiced_amount = parseFloat(String(row[10] ?? '0').replace(/[^0-9.-]/g, '')) || 0;

    if (!client_name || !payable_date || final_invoiced_amount <= 0) continue;

    rows.push({
      client_name,
      payable_date,
      final_invoiced_amount,
      deal: String(row[1] ?? '').trim() || undefined,
    });
  }

  return { runDate, batchIdPrefix, rows };
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : DEFAULT_FILES;

  console.log('\n=== Import Approved Commission from Excel ===\n');
  console.log(`Files: ${files.join(', ')}\n`);

  const db = getLocalDB();

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalUnmatched = 0;

  for (const filePath of files) {
    try {
      const { runDate, batchIdPrefix, rows } = parseExcelFile(filePath);
      console.log(`${filePath}`);
      console.log(`  Run date: ${runDate}, Batch prefix: ${batchIdPrefix}, Rows: ${rows.length}`);

      // Find batch by run_date and id prefix
      const batches = db.prepare(`
        SELECT id, bdr_id FROM commission_batches
        WHERE run_date = ? AND id LIKE ?
        ORDER BY created_at DESC
      `).all(runDate, `${batchIdPrefix}%`) as Array<{ id: string; bdr_id: string }>;

      const batch = batches[0];
      if (!batch) {
        console.log(`  ⚠ No batch found for ${runDate} / ${batchIdPrefix}; skipping file.\n`);
        totalUnmatched += rows.length;
        continue;
      }

      const insertFp = db.prepare(`
        INSERT INTO approved_commission_fingerprints (id, bdr_id, deal_id, effective_date, amount, batch_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const checkExists = db.prepare(`
        SELECT 1 FROM approved_commission_fingerprints
        WHERE bdr_id = ? AND deal_id = ? AND effective_date = ? AND ABS(amount - ?) < 0.01
        LIMIT 1
      `);

      let fileInserted = 0;
      let fileSkipped = 0;
      let fileUnmatched = 0;

      for (const row of rows) {
        const effectiveDate = row.payable_date.includes('-') ? row.payable_date.slice(0, 10) : (row.payable_date.length >= 7 ? `${row.payable_date.slice(0, 4)}-${row.payable_date.slice(4, 6)}-01` : row.payable_date);
        if (!effectiveDate) continue;

        // Match: client_name + (payable_date or accrual_date or month) + amount
        const match = db.prepare(`
          SELECT ce.deal_id FROM commission_entries ce
          JOIN deals d ON ce.deal_id = d.id
          WHERE trim(d.client_name) = trim(?) AND ce.bdr_id = ?
            AND (
              substr(ce.payable_date, 1, 10) = ?
              OR substr(ce.accrual_date, 1, 10) = ?
              OR (ce.month || '-01') = substr(?, 1, 7) || '-01'
            )
            AND ABS(COALESCE(ce.amount, 0) - ?) < 0.02
          LIMIT 1
        `).get(row.client_name, batch.bdr_id, effectiveDate, effectiveDate, effectiveDate, row.final_invoiced_amount) as { deal_id: string } | undefined;

        if (!match) {
          fileUnmatched++;
          totalUnmatched++;
          console.log(`    ⊘ Unmatched: ${row.client_name} ${effectiveDate} $${row.final_invoiced_amount}`);
          continue;
        }

        const alreadyExists = checkExists.get(batch.bdr_id, match.deal_id, effectiveDate, row.final_invoiced_amount);
        if (alreadyExists) {
          fileSkipped++;
          totalSkipped++;
          continue;
        }

        insertFp.run(generateUUID(), batch.bdr_id, match.deal_id, effectiveDate, row.final_invoiced_amount, batch.id);
        fileInserted++;
        totalInserted++;
      }

      console.log(`  ✓ Inserted: ${fileInserted}, Skipped (exists): ${fileSkipped}, Unmatched: ${fileUnmatched}\n`);
    } catch (err: any) {
      console.error(`  ✗ Error: ${err.message}\n`);
    }
  }

  console.log(`Done. Total inserted: ${totalInserted}, skipped: ${totalSkipped}, unmatched: ${totalUnmatched}\n`);
}

main();
