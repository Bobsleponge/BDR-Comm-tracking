/**
 * Reconcile approved March Excel exports vs current local DB (and Supabase when env is set).
 * Run: cd repo && npx tsx scripts/reconcile-march-reports.ts
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as XLSX from 'xlsx';

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
loadEnvFile(resolve(process.cwd(), '.env'));
import { format } from 'date-fns';
import { getLocalDB } from '../lib/db/local-db';
import { fetchPayableBonusRowsLocal } from '../lib/dashboard/quarterly-bonus-export';
import { parseQuarter } from '../lib/commission/calculator';

const COMMISSION_FILE =
  process.env.COMMISSION_XLSX ||
  'commission-report-2026-03-31-d5bb2eef.xlsx';
const BONUS_FILE =
  process.env.BONUS_XLSX ||
  'quarterly-bonus-report-2026-Q1-payable-2026-03-31 (3).xlsx';

interface CommissionRow {
  client_name: string;
  deal: string;
  payable_date: string;
  amount_claimed_on: string;
  is_renewal: string;
  previous_deal_amount: string;
  new_deal_amount: string;
  commission_pct: string;
  original_commission: string;
  override_amount: string;
  final_invoiced_amount: number;
}

function parseCommissionExcel(path: string): { rows: CommissionRow[]; monthTotalFromHeading: number; excelGrandTotal: number } {
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' }) as string[][];

  const rows: CommissionRow[] = [];
  let monthTotalFromHeading = 0;
  let excelGrandTotal = 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row?.length) continue;
    const first = String(row[0] ?? '').trim();
    if (!first) continue;
    if (first === 'Client' || first === 'TOTAL') {
      if (first === 'TOTAL') {
        const last = row[10] ?? row[row.length - 1];
        excelGrandTotal = parseFloat(String(last).replace(/[^0-9.-]/g, '')) || 0;
      }
      continue;
    }
    if (first.includes('—') && first.includes('$')) {
      const m = first.match(/\$([\d,]+\.?\d*)/);
      if (m) monthTotalFromHeading += parseFloat(m[1].replace(/,/g, '')) || 0;
      continue;
    }

    const finalRaw = row[10] ?? '';
    const final = parseFloat(String(finalRaw).replace(/[^0-9.-]/g, '')) || 0;
    rows.push({
      client_name: first,
      deal: String(row[1] ?? '').trim(),
      payable_date: String(row[2] ?? '').trim(),
      amount_claimed_on: String(row[3] ?? '').trim(),
      is_renewal: String(row[4] ?? '').trim(),
      previous_deal_amount: String(row[5] ?? '').trim(),
      new_deal_amount: String(row[6] ?? '').trim(),
      commission_pct: String(row[7] ?? '').trim(),
      original_commission: String(row[8] ?? '').trim(),
      override_amount: String(row[9] ?? '').trim(),
      final_invoiced_amount: final,
    });
  }

  const sumRows = rows.reduce((s, r) => s + r.final_invoiced_amount, 0);
  if (excelGrandTotal === 0) excelGrandTotal = sumRows;

  return { rows, monthTotalFromHeading, excelGrandTotal: excelGrandTotal || sumRows };
}

interface BonusRow {
  client_name: string;
  deal: string;
  payable_date: string;
  collection_date: string;
  entry_commission: number;
  attributed_revenue: number;
  bonus_at_2_5: number;
}

function parseBonusExcel(path: string): {
  bdrFromPreamble: string | null;
  excelTotalRev: number | null;
  excelTotalBonus: number | null;
  rows: BonusRow[];
} {
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' }) as string[][];

  let bdrFromPreamble: string | null = null;
  let excelTotalRev: number | null = null;
  let excelTotalBonus: number | null = null;

  for (const row of data) {
    const line = String(row[0] ?? '');
    const bdrM = line.match(/BDR:\s*([^|]+)/);
    if (bdrM) bdrFromPreamble = bdrM[1].trim();
    const totM = line.match(/Total attributed revenue:\s*\$?([\d,]+\.?\d*)\s*\|\s*Total quarterly bonus[^$]*\$?([\d,]+\.?\d*)/i);
    if (totM) {
      excelTotalRev = parseFloat(totM[1].replace(/,/g, ''));
      excelTotalBonus = parseFloat(totM[2].replace(/,/g, ''));
    }
  }

  let headerIdx = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i]?.[0]) === 'Client' && String(data[i]?.[6]).includes('Bonus')) {
      headerIdx = i;
      break;
    }
  }

  const rows: BonusRow[] = [];
  if (headerIdx >= 0) {
    for (let i = headerIdx + 1; i < data.length; i++) {
      const row = data[i];
      const first = String(row?.[0] ?? '').trim();
      if (!first || first === 'TOTAL') continue;
      if (first.includes('—') && first.includes('revenue')) continue;
      rows.push({
        client_name: first,
        deal: String(row[1] ?? '').trim(),
        payable_date: String(row[2] ?? '').trim().split('T')[0],
        collection_date: String(row[3] ?? '').trim().split('T')[0],
        entry_commission: parseFloat(String(row[4] ?? '0').replace(/[^0-9.-]/g, '')) || 0,
        attributed_revenue: parseFloat(String(row[5] ?? '0').replace(/[^0-9.-]/g, '')) || 0,
        bonus_at_2_5: parseFloat(String(row[6] ?? '0').replace(/[^0-9.-]/g, '')) || 0,
      });
    }
  }

  return { bdrFromPreamble, excelTotalRev, excelTotalBonus, rows };
}

function rowKey(r: { client_name: string; deal: string; payable_date: string; amt: number }) {
  const c = r.client_name.trim();
  const d = r.deal.trim();
  return `${c}|${d}|${r.payable_date}|${r.amt.toFixed(2)}`;
}

async function trySupabase(bdrId: string, start: string, end: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    return { ok: false as const, reason: 'NEXT_PUBLIC_SUPABASE_URL or service/anon key not set' };
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, key);
  const { fetchPayableBonusRowsSupabase } = await import('../lib/dashboard/quarterly-bonus-export');
  const data = await fetchPayableBonusRowsSupabase(supabase as any, bdrId, start, end);
  return { ok: true as const, data };
}

async function main() {
  const cwd = process.cwd();
  const commissionPath = COMMISSION_FILE.startsWith('/') ? COMMISSION_FILE : `${cwd}/${COMMISSION_FILE}`;
  const bonusPath = BONUS_FILE.startsWith('/') ? BONUS_FILE : `${cwd}/${BONUS_FILE}`;

  console.log('\n=== March report reconciliation ===\n');
  console.log('Commission file:', commissionPath);
  console.log('Bonus file:', bonusPath);

  const db = getLocalDB();

  const commissionParsed = parseCommissionExcel(commissionPath);
  const sumCommission = commissionParsed.rows.reduce((s, r) => s + r.final_invoiced_amount, 0);
  console.log('\n--- Commission batch Excel ---');
  console.log('Data rows:', commissionParsed.rows.length);
  console.log('Sum of final_invoiced_amount:', sumCommission.toFixed(2));
  console.log('Excel TOTAL row / computed:', commissionParsed.excelGrandTotal.toFixed(2));

  const batches = db
    .prepare(
      `SELECT id, bdr_id, status, run_date FROM commission_batches WHERE id LIKE 'd5bb2eef%' OR run_date = '2026-03-31'`
    )
    .all() as Array<{ id: string; bdr_id: string; status: string; run_date: string }>;
  console.log('\n--- Local DB: batch d5bb2eef / run_date 2026-03-31 ---');
  if (batches.length === 0) {
    console.log('No matching batch in local.db (prefix d5bb2eef or run_date 2026-03-31).');
  } else {
    for (const b of batches) {
      const snap = db.prepare('SELECT length(snapshot_data) as n FROM commission_batch_snapshots WHERE batch_id = ?').get(b.id) as { n: number } | undefined;
      console.log(`Batch ${b.id} bdr=${b.bdr_id} status=${b.status} run_date=${b.run_date} snapshot_bytes=${snap?.n ?? 0}`);
    }
  }

  const bonusParsed = parseBonusExcel(bonusPath);
  const bdrId = bonusParsed.bdrFromPreamble || 'test-bdr-id';
  console.log('\n--- Quarterly bonus Excel ---');
  console.log('BDR from preamble:', bonusParsed.bdrFromPreamble);
  console.log('Excel preamble totals — attributed revenue:', bonusParsed.excelTotalRev, 'bonus:', bonusParsed.excelTotalBonus);
  console.log('Data rows:', bonusParsed.rows.length);

  const { start, end } = parseQuarter('2026-Q1');
  const startStr = format(start, 'yyyy-MM-dd');
  const endStr = format(end, 'yyyy-MM-dd');

  const localBonus = fetchPayableBonusRowsLocal(db, bdrId, startStr, endStr);
  console.log('\n--- Local recompute (fetchPayableBonusRowsLocal) ---');
  console.log('BDR:', bdrId, 'Quarter:', '2026-Q1', startStr, '→', endStr);
  console.log('totalAttributedRevenue:', localBonus.totalAttributedRevenue);
  console.log('totalBonus (2.5%):', localBonus.totalBonus);
  console.log('Row count:', localBonus.rows.length);

  const revDiff =
    bonusParsed.excelTotalRev != null ? localBonus.totalAttributedRevenue - bonusParsed.excelTotalRev : null;
  const bonusDiff =
    bonusParsed.excelTotalBonus != null ? localBonus.totalBonus - bonusParsed.excelTotalBonus : null;
  console.log('Delta vs Excel preamble — revenue:', revDiff != null ? revDiff.toFixed(2) : 'n/a', 'bonus:', bonusDiff != null ? bonusDiff.toFixed(2) : 'n/a');

  const excelKeys = new Map<string, number>();
  for (const r of bonusParsed.rows) {
    const k = rowKey({
      client_name: r.client_name,
      deal: r.deal,
      payable_date: r.payable_date,
      amt: r.attributed_revenue,
    });
    excelKeys.set(k, (excelKeys.get(k) || 0) + 1);
  }
  const dbKeys = new Map<string, number>();
  for (const r of localBonus.rows) {
    const rev = parseFloat(r.attributed_revenue || '0');
    const k = rowKey({
      client_name: r.client_name,
      deal: r.deal,
      payable_date: r.payable_date,
      amt: rev,
    });
    dbKeys.set(k, (dbKeys.get(k) || 0) + 1);
  }

  let onlyExcel = 0;
  let onlyDb = 0;
  for (const [k, c] of excelKeys) {
    const d = dbKeys.get(k) || 0;
    if (c > d) onlyExcel += c - d;
  }
  for (const [k, c] of dbKeys) {
    const e = excelKeys.get(k) || 0;
    if (c > e) onlyDb += c - e;
  }
  console.log('\nLine-level key match (client|deal|payable|attributed):');
  console.log('Keys only in Excel:', onlyExcel);
  console.log('Keys only in local recompute:', onlyDb);

  const missingInDb: string[] = [];
  for (const k of excelKeys.keys()) {
    if (!dbKeys.has(k)) missingInDb.push(k);
  }
  if (missingInDb.length) {
    console.log('\nSample keys in Excel not in local (max 12):');
    missingInDb.slice(0, 12).forEach((x) => console.log(' ', x));
  }
  const missingInExcel: string[] = [];
  for (const k of dbKeys.keys()) {
    if (!excelKeys.has(k)) missingInExcel.push(k);
  }
  if (missingInExcel.length) {
    console.log('\nSample keys in local not in Excel (max 12):');
    missingInExcel.slice(0, 12).forEach((x) => console.log(' ', x));
  }

  const march = commissionParsed.rows.filter((r) => (r.payable_date || '').startsWith('2026-03'));
  const ceMarch = db
    .prepare(
      `
    SELECT ce.amount, ce.payable_date, d.client_name, COALESCE(ds.service_name, d.service_type) as deal
    FROM commission_entries ce
    JOIN deals d ON ce.deal_id = d.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
    WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
      AND ce.payable_date >= '2026-03-01' AND ce.payable_date <= '2026-03-31'
    ORDER BY ce.payable_date
  `
    )
    .all(bdrId) as Array<{ amount: number; payable_date: string; client_name: string; deal: string }>;

  console.log('\n--- Commission report vs commission_entries (March 2026, same BDR) ---');
  console.log('Excel March rows:', march.length, 'sum:', march.reduce((s, r) => s + r.final_invoiced_amount, 0).toFixed(2));
  console.log('DB March entries:', ceMarch.length, 'sum amount:', ceMarch.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2));

  const sup = await trySupabase(bdrId, startStr, endStr);
  console.log('\n--- Supabase ---');
  if (!sup.ok) {
    console.log('Skipped:', sup.reason);
  } else {
    console.log('totalAttributedRevenue:', sup.data.totalAttributedRevenue);
    console.log('totalBonus:', sup.data.totalBonus);
    console.log('rows:', sup.data.rows.length);
    const revD2 =
      bonusParsed.excelTotalRev != null ? sup.data.totalAttributedRevenue - bonusParsed.excelTotalRev : null;
    const bonD2 =
      bonusParsed.excelTotalBonus != null ? sup.data.totalBonus - bonusParsed.excelTotalBonus : null;
    console.log('Delta vs Excel preamble — revenue:', revD2 != null ? revD2.toFixed(2) : 'n/a', 'bonus:', bonD2 != null ? bonD2.toFixed(2) : 'n/a');
  }
  console.log('\nDone.\n');
}

void main();
