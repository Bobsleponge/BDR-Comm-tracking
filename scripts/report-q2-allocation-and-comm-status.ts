/**
 * For Q1 commission lines that participate in quarterly bonus but are NOT on the Q1 bonus Excel
 * (same rule as sync-approved-from-reports → would get payable_date moved to Q2):
 *   report each line's normal commission status (paid / payable / accrued) and whether it appears
 *   on the commission batch Excel (regular commission payment list).
 *
 * Run: npx tsx scripts/report-q2-allocation-and-comm-status.ts
 *
 * Env: COMMISSION_XLSX, BONUS_XLSX, BDR_ID (same as sync), Q1_YEAR=2026
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import * as XLSX from 'xlsx';
import { getLocalDB } from '../lib/db/local-db';
import { attributedRevenueFromEntry } from '../lib/dashboard/quarterly-bonus-export';
import { format } from 'date-fns';
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

interface CommRow {
  client_name: string;
  deal: string;
  payable_date: string;
  final_invoiced_amount: number;
}

function parseCommissionExcel(path: string): CommRow[] {
  const wb = XLSX.readFile(path);
  const data = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }) as string[][];
  const rows: CommRow[] = [];
  for (const row of data) {
    const first = String(row[0] ?? '').trim();
    if (!first || first === 'Client' || first === 'TOTAL') continue;
    if (first.includes('—') && first.includes('$')) continue;
    const final = parseFloat(String(row[10] ?? '').replace(/[^0-9.-]/g, '')) || 0;
    rows.push({
      client_name: first,
      deal: String(row[1] ?? '').trim(),
      payable_date: String(row[2] ?? '').trim().split('T')[0],
      final_invoiced_amount: final,
    });
  }
  return rows;
}

interface BonusRow {
  client_name: string;
  deal: string;
  payable_date: string;
  attributed_revenue: number;
}

function parseBonusExcel(path: string): { bdr: string | null; rows: BonusRow[] } {
  const wb = XLSX.readFile(path);
  const data = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }) as string[][];
  let bdr: string | null = null;
  for (const row of data) {
    const line = String(row[0] ?? '');
    const m = line.match(/BDR:\s*([^|]+)/);
    if (m) bdr = m[1].trim();
  }
  let headerIdx = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i]?.[0]) === 'Client' && String(data[i]?.[6] ?? '').includes('Bonus')) {
      headerIdx = i;
      break;
    }
  }
  const rows: BonusRow[] = [];
  if (headerIdx < 0) return { bdr, rows };
  for (let i = headerIdx + 1; i < data.length; i++) {
    const row = data[i];
    const first = String(row?.[0] ?? '').trim();
    if (!first || first === 'TOTAL') continue;
    if (first.includes('—') && first.includes('revenue')) continue;
    rows.push({
      client_name: first.trim(),
      deal: String(row[1] ?? '').trim(),
      payable_date: String(row[2] ?? '').trim().split('T')[0],
      attributed_revenue: parseFloat(String(row[5] ?? '0').replace(/[^0-9.-]/g, '')) || 0,
    });
  }
  return { bdr, rows };
}

function norm(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function bonusKey(c: string, d: string, pd: string, attr: number) {
  return `${norm(c)}|${norm(d)}|${pd}|${attr.toFixed(2)}`;
}

function findCommissionEntryForReport(
  db: ReturnType<typeof getLocalDB>,
  bdrId: string,
  r: CommRow
): { id: string } | null {
  const pd = r.payable_date.slice(0, 10);
  const raw = db
    .prepare(
      `
    SELECT ce.id, ce.deal_id, ce.amount as ce_amount, ce.payable_date,
           d.client_name,
           COALESCE(ds.service_name, d.service_type) as deal_label
    FROM commission_entries ce
    JOIN deals d ON ce.deal_id = d.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
    WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
      AND substr(ce.payable_date, 1, 10) = ?
      AND lower(trim(d.client_name)) = lower(trim(?))
  `
    )
    .all(bdrId, pd, r.client_name) as Array<{
    id: string;
    deal_id: string;
    ce_amount: number;
    payable_date: string;
    client_name: string;
    deal_label: string;
  }>;

  if (raw.length === 0) return null;
  if (raw.length === 1) return { id: raw[0].id };

  const dealN = norm(r.deal);
  let best: (typeof raw)[0] | null = null;
  let bestScore = -1;
  for (const c of raw) {
    const label = norm(c.deal_label);
    let score = 0;
    if (label === dealN) score += 100;
    else if (label.includes(dealN) || dealN.includes(label)) score += 50;
    const amtDiff = Math.abs(Number(c.ce_amount ?? 0) - r.final_invoiced_amount);
    if (amtDiff < 0.02) score += 40;
    else if (amtDiff < 1) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best ? { id: best.id } : null;
}

function main() {
  const commissionPath =
    process.env.COMMISSION_XLSX || resolve(process.cwd(), 'commission-report-2026-03-31-d5bb2eef.xlsx');
  const bonusPath =
    process.env.BONUS_XLSX ||
    resolve(process.cwd(), 'quarterly-bonus-report-2026-Q1-payable-2026-03-31 (3).xlsx');
  const q1Key = process.env.Q1_QUARTER || '2026-Q1';

  if (!existsSync(commissionPath) || !existsSync(bonusPath)) {
    console.error('Need COMMISSION_XLSX and BONUS_XLSX files.');
    process.exit(1);
  }

  const db = getLocalDB();
  const commRows = parseCommissionExcel(commissionPath);
  const { bdr: bdrFromBonus, rows: bonusRows } = parseBonusExcel(bonusPath);
  const bdrId = process.env.BDR_ID || bdrFromBonus || 'test-bdr-id';

  const onCommissionSheet = new Set<string>();
  for (const r of commRows) {
    const ce = findCommissionEntryForReport(db, bdrId, r);
    if (ce) onCommissionSheet.add(ce.id);
  }

  const { start, end } = parseQuarter(q1Key);
  const q1Start = format(start, 'yyyy-MM-dd');
  const q1End = format(end, 'yyyy-MM-dd');

  const raw = db
    .prepare(
      `
    SELECT
      ce.id,
      ce.amount as ce_amount,
      ce.status,
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
    .all(bdrId, q1Start, q1End) as Array<{
    id: string;
    ce_amount: number;
    status: string;
    payable_date: string;
    re_id: string | null;
    amount_collected: number | null;
    client_name: string;
    deal_label: string;
  }>;

  const approvedBonusKeys = new Set(
    bonusRows.map((r) => bonusKey(r.client_name, r.deal, r.payable_date, r.attributed_revenue))
  );

  const lines: Array<{
    id: string;
    client: string;
    deal: string;
    payable_date: string;
    attr: number;
    commAmount: number;
    commStatus: string;
    onCommReportExcel: boolean;
    onQ1BonusExcel: boolean;
    wouldMovePayableToQ2: boolean;
  }> = [];

  for (const r of raw) {
    const rev = attributedRevenueFromEntry(Number(r.ce_amount ?? 0), r.re_id, r.amount_collected);
    const pd = (r.payable_date || '').split('T')[0];
    const k = bonusKey(r.client_name ?? '', r.deal_label, pd, rev);
    const onBonus = approvedBonusKeys.has(k);
    const wouldMove = !onBonus;
    lines.push({
      id: r.id,
      client: r.client_name ?? '',
      deal: r.deal_label ?? '',
      payable_date: pd,
      attr: rev,
      commAmount: Number(r.ce_amount ?? 0),
      commStatus: r.status,
      onCommReportExcel: onCommissionSheet.has(r.id),
      onQ1BonusExcel: onBonus,
      wouldMovePayableToQ2: wouldMove,
    });
  }

  const toReview = lines.filter((l) => l.wouldMovePayableToQ2);

  console.log('\n=== Q1 → Q2 bonus allocation vs normal commission payment ===\n');
  console.log('BDR:', bdrId, 'Quarter:', q1Key, q1Start, '→', q1End);
  console.log(
    'Lines with payable in Q1 that would move to Q2 (not on Q1 bonus Excel):',
    toReview.length,
    'of',
    lines.length,
    'Q1 bonus-participant lines\n'
  );
  console.log(
    '— Normal commission = commission_entries.status + whether the line is on the commission batch Excel.'
  );
  console.log('— Quarterly bonus = Q1 bonus Excel row match; if no match, payable_date → Q2 (when you run sync).\n');

  console.log(
    'Client | Deal | Payable | Attr.rev | Comm $ | Comm status | On comm Excel? | Normal comm received?'
  );
  console.log('-'.repeat(120));
  for (const l of toReview) {
    const normalReceived = l.commStatus === 'paid' && l.onCommReportExcel;
    const partial =
      l.commStatus === 'paid' && !l.onCommReportExcel
        ? 'PAID in DB but NOT on comm Excel (investigate)'
        : l.commStatus === 'paid' && l.onCommReportExcel
          ? 'yes (paid + on sheet)'
          : l.onCommReportExcel
            ? `on sheet but status=${l.commStatus}`
            : `not on sheet, status=${l.commStatus}`;
    console.log(
      `${l.client.slice(0, 22).padEnd(22)} | ${l.deal.slice(0, 18).padEnd(18)} | ${l.payable_date} | ${l.attr.toFixed(0).padStart(8)} | ${l.commAmount.toFixed(2).padStart(8)} | ${l.commStatus.padEnd(8)} | ${(l.onCommReportExcel ? 'yes' : 'no').padEnd(12)} | ${partial}`
    );
  }

  const reportDir = resolve(process.cwd(), 'reports');
  try {
    mkdirSync(reportDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const out = resolve(reportDir, `q2-allocation-vs-comm-${q1Key.replace('-', '')}.txt`);
  const text = [
    `BDR ${bdrId} ${q1Key}`,
    `Lines moving to Q2 (bonus): ${toReview.length}`,
    '',
    ...toReview.map(
      (l) =>
        `${l.id}\t${l.client}\t${l.deal}\t${l.payable_date}\t${l.attr.toFixed(2)}\t${l.commAmount.toFixed(2)}\t${l.commStatus}\tcomm_excel=${l.onCommReportExcel}`
    ),
  ].join('\n');
  writeFileSync(out, text, 'utf8');
  console.log('\nWrote:', out);
  console.log('');
}

main();
