/**
 * Reconcile Q1 quarterly bonus: approved list (bonus Excel) vs current app calculation + DB rows.
 *
 * Establishes:
 *   - Totals approved on the quarterly Excel (authoritative for "what was approved")
 *   - What the app computes today for the same quarter (payable_date in Q1)
 *   - Line-level: only Excel / only DB / matched (with bonus delta)
 *   - What still needs to be paid: approved bonus total (no quarterly_bonus_paid in schema — track payout externally)
 *     plus rows that are approved but unmatched in DB (cannot verify from system)
 *
 * Run: npx tsx scripts/reconcile-quarterly-bonus-approved-vs-due.ts
 *
 * Env: BONUS_XLSX, BDR_ID, Q1_QUARTER=2026-Q1, COMMISSION_XLSX (optional, for context)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import * as XLSX from 'xlsx';
import { format } from 'date-fns';
import { getLocalDB } from '../lib/db/local-db';
import { attributedRevenueFromEntry, QUARTERLY_BONUS_RATE } from '../lib/dashboard/quarterly-bonus-export';
import { parseQuarter } from '../lib/commission/calculator';

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

interface ExcelBonusRow {
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
  rows: ExcelBonusRow[];
} {
  const wb = XLSX.readFile(path);
  const data = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }) as string[][];

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
    if (String(data[i]?.[0]) === 'Client' && String(data[i]?.[6] ?? '').includes('Bonus')) {
      headerIdx = i;
      break;
    }
  }

  const rows: ExcelBonusRow[] = [];
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

function norm(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function bonusKey(c: string, d: string, pd: string, attr: number) {
  return `${norm(c)}|${norm(d)}|${pd}|${attr.toFixed(2)}`;
}

type DbRow = {
  id: string;
  status: string;
  ce_amount: number;
  payable_date: string;
  re_id: string | null;
  amount_collected: number | null;
  client_name: string;
  deal_label: string;
  attributed_revenue: number;
  bonus_at_2_5: number;
};

function fetchQ1BonusRowsWithIds(
  db: ReturnType<typeof getLocalDB>,
  bdrId: string,
  qStart: string,
  qEnd: string
): DbRow[] {
  const raw = db
    .prepare(
      `
    SELECT
      ce.id,
      ce.status,
      ce.amount as ce_amount,
      ce.payable_date,
      re.id as re_id,
      re.amount_collected,
      d.client_name,
      COALESCE(ds.service_name, d.service_type) as deal_label
    FROM commission_entries ce
    INNER JOIN deals d ON ce.deal_id = d.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
    WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
      AND ce.payable_date >= ? AND ce.payable_date <= ?
      AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date OR re.id IS NULL)
    ORDER BY ce.payable_date, ce.id
  `
    )
    .all(bdrId, qStart, qEnd) as Array<{
    id: string;
    status: string;
    ce_amount: number;
    payable_date: string;
    re_id: string | null;
    amount_collected: number | null;
    client_name: string;
    deal_label: string;
  }>;

  return raw.map((r) => {
    const rev = attributedRevenueFromEntry(Number(r.ce_amount ?? 0), r.re_id, r.amount_collected);
    const bonus = rev * QUARTERLY_BONUS_RATE;
    const pd = (r.payable_date || '').split('T')[0];
    return {
      id: r.id,
      status: r.status,
      ce_amount: Number(r.ce_amount ?? 0),
      payable_date: pd,
      re_id: r.re_id,
      amount_collected: r.amount_collected,
      client_name: r.client_name ?? '',
      deal_label: r.deal_label ?? '',
      attributed_revenue: rev,
      bonus_at_2_5: bonus,
    };
  });
}

function main() {
  const bonusPath =
    process.env.BONUS_XLSX ||
    resolve(process.cwd(), 'quarterly-bonus-report-2026-Q1-payable-2026-03-31 (3).xlsx');
  const q1Quarter = process.env.Q1_QUARTER || '2026-Q1';

  if (!existsSync(bonusPath)) {
    console.error('BONUS_XLSX not found:', bonusPath);
    process.exit(1);
  }

  const { bdrFromPreamble, excelTotalRev, excelTotalBonus, rows: excelRows } = parseBonusExcel(bonusPath);
  const bdrId = process.env.BDR_ID || bdrFromPreamble || 'test-bdr-id';
  const { start, end } = parseQuarter(q1Quarter);
  const qStart = format(start, 'yyyy-MM-dd');
  const qEnd = format(end, 'yyyy-MM-dd');

  const db = getLocalDB();
  const dbRows = fetchQ1BonusRowsWithIds(db, bdrId, qStart, qEnd);

  const sumExcelAttr = excelRows.reduce((s, r) => s + r.attributed_revenue, 0);
  const sumExcelBonus = excelRows.reduce((s, r) => s + r.bonus_at_2_5, 0);
  const sumDbAttr = dbRows.reduce((s, r) => s + r.attributed_revenue, 0);
  const sumDbBonus = dbRows.reduce((s, r) => s + r.bonus_at_2_5, 0);

  const excelByKey = new Map<string, ExcelBonusRow[]>();
  for (const r of excelRows) {
    const k = bonusKey(r.client_name, r.deal, r.payable_date, r.attributed_revenue);
    if (!excelByKey.has(k)) excelByKey.set(k, []);
    excelByKey.get(k)!.push(r);
  }
  const dbByKey = new Map<string, DbRow[]>();
  for (const r of dbRows) {
    const k = bonusKey(r.client_name, r.deal_label, r.payable_date, r.attributed_revenue);
    if (!dbByKey.has(k)) dbByKey.set(k, []);
    dbByKey.get(k)!.push(r);
  }

  const allKeys = new Set([...excelByKey.keys(), ...dbByKey.keys()]);
  const matched: { excel: ExcelBonusRow; db: DbRow }[] = [];
  const onlyExcel: ExcelBonusRow[] = [];
  const onlyDb: DbRow[] = [];

  for (const k of allKeys) {
    const ex = [...(excelByKey.get(k) || [])];
    const dbs = [...(dbByKey.get(k) || [])];
    const n = Math.min(ex.length, dbs.length);
    for (let i = 0; i < n; i++) matched.push({ excel: ex[i], db: dbs[i] });
    for (let i = n; i < ex.length; i++) onlyExcel.push(ex[i]);
    for (let i = n; i < dbs.length; i++) onlyDb.push(dbs[i]);
  }

  const onlyExcelBonus = onlyExcel.reduce((s, r) => s + r.bonus_at_2_5, 0);
  const onlyDbBonus = onlyDb.reduce((s, r) => s + r.bonus_at_2_5, 0);
  const matchedBonusApproved = matched.reduce((s, m) => s + m.excel.bonus_at_2_5, 0);

  const perf = db
    .prepare(`SELECT bonus_eligible, revenue_collected, achieved_percent FROM quarterly_performance WHERE bdr_id = ? AND quarter = ?`)
    .get(bdrId, q1Quarter) as { bonus_eligible: number; revenue_collected: number; achieved_percent: number } | undefined;

  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  log('\n══════════════════════════════════════════════════════════════════════════════');
  log('  QUARTERLY BONUS — APPROVED (Excel) vs CURRENT CALC (DB) vs STILL DUE');
  log('══════════════════════════════════════════════════════════════════════════════\n');
  log(`BDR: ${bdrId}  Quarter: ${q1Quarter} (${qStart} → ${qEnd})`);
  log(`Bonus Excel file: ${bonusPath}\n`);

  log('── 1) APPROVED ON QUARTERLY BONUS EXCEL (source of truth for Q1 bonus approval) ──');
  log(`   Data rows: ${excelRows.length}`);
  log(`   Sum attributed (from rows):     $${sumExcelAttr.toFixed(2)}`);
  log(`   Sum quarterly bonus (2.5%):     $${sumExcelBonus.toFixed(2)}`);
  if (excelTotalRev != null && excelTotalBonus != null) {
    log(`   Preamble on sheet:              $${excelTotalRev.toFixed(2)} attr | $${excelTotalBonus.toFixed(2)} bonus`);
    const rowVsPre = Math.abs(sumExcelBonus - excelTotalBonus);
    if (rowVsPre > 0.05) log(`   Note: row sum vs preamble bonus diff: $${rowVsPre.toFixed(2)}`);
  }

  log('\n── 2) CURRENT APP STRUCTURE (commission_entries with payable_date in quarter) ──');
  log(`   Rows included:                  ${dbRows.length}`);
  log(`   Total attributed (recomputed):  $${sumDbAttr.toFixed(2)}`);
  log(`   Total quarterly bonus (2.5%):   $${sumDbBonus.toFixed(2)}`);
  log(`   Delta vs Excel row bonus:       $${(sumDbBonus - sumExcelBonus).toFixed(2)}`);
  log(`   Delta vs Excel row attributed:  $${(sumDbAttr - sumExcelAttr).toFixed(2)}`);

  log('\n── 3) quarterly_performance (local DB) ──');
  if (perf) {
    log(
      `   bonus_eligible: ${perf.bonus_eligible ? 'Yes' : 'No'} | revenue_collected (cash basis field): $${Number(perf.revenue_collected).toFixed(2)} | ${Number(perf.achieved_percent).toFixed(1)}%`
    );
  } else {
    log('   No row for this BDR/quarter (dashboard may still compute bonus from commission lines).');
  }

  log('\n── 4) LINE MATCH (client|deal|payable_date|attributed) ──');
  log(`   Matched (Excel + DB):           ${matched.length}`);
  log(`   Approved Excel only (no DB key): ${onlyExcel.length}  → bonus subtotal $${onlyExcelBonus.toFixed(2)}`);
  log(`   In DB calc only (not on Excel): ${onlyDb.length}  → bonus subtotal $${onlyDbBonus.toFixed(2)} (not approved for Q1 sheet — usually Q2 or data fix)`);

  if (onlyExcel.length) {
    log('\n   --- Rows on APPROVED Excel but NOT in current Q1 DB calculation ---');
    for (const r of onlyExcel.slice(0, 25)) {
      log(
        `      ${r.client_name} | ${r.deal} | ${r.payable_date} | attr $${r.attributed_revenue.toFixed(2)} | bonus $${r.bonus_at_2_5.toFixed(2)}`
      );
    }
    if (onlyExcel.length > 25) log(`      ... +${onlyExcel.length - 25} more`);
  }

  if (onlyDb.length) {
    log('\n   --- Rows in DB Q1 calc but NOT on approved Excel ---');
    for (const r of onlyDb.slice(0, 25)) {
      log(
        `      ${r.client_name} | ${r.deal_label} | ${r.payable_date} | attr $${r.attributed_revenue.toFixed(2)} | bonus $${r.bonus_at_2_5.toFixed(2)} | comm status ${r.status}`
      );
    }
    if (onlyDb.length > 25) log(`      ... +${onlyDb.length - 25} more`);
  }

  log('\n── 5) MATCHED LINES — commission entry status (normal comm; bonus is separate) ──');
  log(`   Approved bonus on matched lines: $${matchedBonusApproved.toFixed(2)}`);
  const statusCounts = new Map<string, number>();
  for (const m of matched) {
    const st = m.db.status;
    statusCounts.set(st, (statusCounts.get(st) || 0) + 1);
  }
  log(`   Matched line statuses: ${[...statusCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

  log('\n── 6) WHAT STILL NEEDS TO BE PAID (QUARTERLY BONUS) ──');
  log('   The database does not store "quarterly bonus paid" per line. Use the Excel as the approval amount.');
  log(`\n   A) Total quarterly bonus APPROVED on sheet (row sum):     $${sumExcelBonus.toFixed(2)}`);
  log(`      Treat this as the Q1 bonus amount finance approved (subject to eligibility rules).`);
  log(`\n   B) Amount that aligns with current DB + same keys:       $${matchedBonusApproved.toFixed(2)}`);
  log(`   C) Approved bonus on lines with NO matching DB row:        $${onlyExcelBonus.toFixed(2)}`);
  log(`      → Reconcile data (payable date, attributed revenue, client/deal labels) before paying these.`);
  log(`\n   D) DB adds bonus not on approved Excel:                    $${onlyDbBonus.toFixed(2)}`);
  log(`      → Do not pay as Q1 approved bonus; include in next quarter or new approval.`);

  const suggestedStillDue = sumExcelBonus;
  log(`\n   SUMMARY — For Q1 payout planning, approved bonus total = $${suggestedStillDue.toFixed(2)}`);
  log(`   Subtract any amounts you already paid outside this app.`);
  log(`   If (C) > 0, fix source data so those lines appear in DB or confirm manual payment.`);

  const reportDir = resolve(process.cwd(), 'reports');
  try {
    mkdirSync(reportDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const outPath = resolve(reportDir, `quarterly-bonus-approved-vs-due-${q1Quarter.replace('-', '')}.txt`);
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  log(`\nWrote: ${outPath}\n`);
}

main();
