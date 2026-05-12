/**
 * Mark commission entries as PAID from approved Excel exports.
 *
 * Commission report Excel is the source of truth for which lines were paid (final column).
 * Optional: Q1 bonus report adds extra matches by attributed-revenue key.
 *
 * COMMISSION_ONLY=1 — use only the commission Excel (no bonus file required).
 *
 * Usage (local SQLite):
 *   MARK_PAID_APPLY=1 COMMISSION_ONLY=1 npx tsx scripts/mark-paid-from-excel-reports.ts
 *
 * Env:
 *   COMMISSION_XLSX — commission batch report .xlsx (required)
 *   BONUS_XLSX — quarterly bonus .xlsx (required unless COMMISSION_ONLY=1)
 *   BDR_ID — BDR uuid (defaults to BDR: line in bonus report, else test-bdr-id)
 *   MARK_PAID_APPLY=1 — required to UPDATE status to paid (otherwise dry-run)
 *   COMMISSION_ONLY=1 — commission file only; ignore bonus matching
 *   MARK_PAID_SUPABASE=1 — after local SQLite updates, also set status=paid on Supabase for the same entry IDs
 *     (needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; use when the app reads cloud, not local.db)
 *   UNPAID_MONTH=2026-03 — payable month (YYYY-MM) for strict reconcile + unpaid summary (local DB)
 *   STRICT_SHEET_RECONCILE=1 — after marking sheet matches paid: for same BDR + UNPAID_MONTH, any other
 *     row still `paid` is set to `payable` (not on sheet → explicitly not paid). Requires ≥1 sheet match
 *     (MARK_PAID_APPLY=1, paidIds non-empty). Use when the Excel is the full paid list for that month.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
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

const APPLY = process.env.MARK_PAID_APPLY === '1' || process.env.MARK_PAID_APPLY === 'true';
const UNPAID_MONTH = process.env.UNPAID_MONTH || '2026-03';
const STRICT_SHEET =
  process.env.STRICT_SHEET_RECONCILE === '1' || process.env.STRICT_SHEET_RECONCILE === 'true';

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

type CeCandidate = {
  id: string;
  deal_id: string;
  ce_amount: number;
  payable_date: string;
  client_name: string;
  deal_label: string;
};

function findCommissionEntryForReport(db: ReturnType<typeof getLocalDB>, bdrId: string, r: CommRow): CeCandidate | null {
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
    .all(bdrId, pd, r.client_name) as CeCandidate[];

  if (raw.length === 0) return null;
  if (raw.length === 1) return raw[0];

  const dealN = norm(r.deal);
  let best: CeCandidate | null = null;
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
  return best;
}

function fetchBonusRowsWithIds(
  db: ReturnType<typeof getLocalDB>,
  bdrId: string,
  start: string,
  end: string
) {
  const raw = db
    .prepare(
      `
    SELECT
      ce.id,
      ce.deal_id,
      ce.amount as ce_amount,
      ce.payable_date,
      re.id as re_id,
      re.amount_collected,
      d.client_name,
      d.service_type,
      ds.service_name
    FROM commission_entries ce
    INNER JOIN deals d ON ce.deal_id = d.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
    WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
      AND ce.payable_date >= ? AND ce.payable_date <= ?
      AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date OR re.id IS NULL)
  `
    )
    .all(bdrId, start, end) as Array<{
    id: string;
    deal_id: string;
    ce_amount: number;
    payable_date: string;
    re_id: string | null;
    amount_collected: number | null;
    client_name: string;
    service_type: string;
    service_name: string | null;
  }>;

  return raw.map((r) => {
    const rev = attributedRevenueFromEntry(Number(r.ce_amount ?? 0), r.re_id, r.amount_collected);
    const dealLabel = r.service_name || r.service_type || 'Deal';
    const pd = (r.payable_date || '').split('T')[0];
    return {
      id: r.id,
      deal_id: r.deal_id,
      client_name: r.client_name ?? '',
      deal_label: dealLabel,
      payable_date: pd,
      attributed_revenue: rev,
      key: bonusKey(r.client_name ?? '', dealLabel, pd, rev),
    };
  });
}

async function updateSupabasePaid(ids: string[]): Promise<{ ok: boolean; error?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { ok: false, error: 'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY' };
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, key);
  const list = [...ids];
  const chunkSize = 80;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('commission_entries')
      .update({ status: 'paid', updated_at: new Date().toISOString() })
      .in('id', chunk);
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true };
}

async function main() {
  const commissionOnly =
    process.env.COMMISSION_ONLY === '1' || process.env.COMMISSION_ONLY === 'true';

  const commissionPath =
    process.env.COMMISSION_XLSX || resolve(process.cwd(), 'commission-report-2026-03-31-d5bb2eef.xlsx');
  const bonusPath =
    process.env.BONUS_XLSX ||
    resolve(process.cwd(), 'quarterly-bonus-report-2026-Q1-payable-2026-03-31 (3).xlsx');

  if (!existsSync(commissionPath)) {
    console.error('Missing commission Excel:', commissionPath);
    console.error('Set COMMISSION_XLSX=/full/path/to/commission-report-....xlsx');
    process.exit(1);
  }
  if (!commissionOnly && !existsSync(bonusPath)) {
    console.error('Missing bonus Excel:', bonusPath);
    console.error('Set BONUS_XLSX=/full/path/to/quarterly-bonus-report-....xlsx');
    console.error('Or set COMMISSION_ONLY=1 to use only the commission Excel.');
    process.exit(1);
  }

  const db = getLocalDB();
  const commRows = parseCommissionExcel(commissionPath);
  const { bdr: bdrFromBonus, rows: bonusRows } = commissionOnly
    ? { bdr: null as string | null, rows: [] as BonusRow[] }
    : parseBonusExcel(bonusPath);
  const bdrId = process.env.BDR_ID || bdrFromBonus || 'test-bdr-id';

  const { start: q1Start, end: q1End } = parseQuarter('2026-Q1');
  const q1StartStr = format(q1Start, 'yyyy-MM-dd');
  const q1EndStr = format(q1End, 'yyyy-MM-dd');

  const paidIds = new Set<string>();
  const fromCommission: string[] = [];
  const fromBonus: string[] = [];
  const unmatchedComm: string[] = [];
  const unmatchedBonus: string[] = [];

  for (const r of commRows) {
    const ce = findCommissionEntryForReport(db, bdrId, r);
    if (!ce) {
      unmatchedComm.push(`${r.client_name} | ${r.payable_date} | ${r.deal} | $${r.final_invoiced_amount.toFixed(2)}`);
      continue;
    }
    if (!paidIds.has(ce.id)) {
      paidIds.add(ce.id);
      fromCommission.push(ce.id);
    }
  }

  const keyToId = new Map<string, string>();
  if (!commissionOnly) {
    const dbBonusLines = fetchBonusRowsWithIds(db, bdrId, q1StartStr, q1EndStr);
    for (const line of dbBonusLines) {
      keyToId.set(line.key, line.id);
    }
  }

  if (!commissionOnly) {
    for (const br of bonusRows) {
      const k = bonusKey(br.client_name, br.deal, br.payable_date, br.attributed_revenue);
      const id = keyToId.get(k);
      if (!id) {
        unmatchedBonus.push(`${br.client_name} | ${br.payable_date} | ${br.deal} | attr $${br.attributed_revenue.toFixed(2)}`);
        continue;
      }
      if (!paidIds.has(id)) {
        paidIds.add(id);
        fromBonus.push(id);
      }
    }
  }

  console.log('\n=== Mark paid from approved Excel reports ===\n');
  console.log('BDR_ID:', bdrId);
  console.log('COMMISSION_ONLY:', commissionOnly);
  console.log('Commission file (source of truth for paid lines):', commissionPath);
  console.log('Bonus file:', commissionOnly ? '(skipped)' : bonusPath);
  console.log('MARK_PAID_APPLY:', APPLY);
  console.log('STRICT_SHEET_RECONCILE:', STRICT_SHEET, `(payable month scope: ${UNPAID_MONTH})`);
  console.log('\nMatched from commission report:', fromCommission.length, 'entries');
  const fromCommSet = new Set(fromCommission);
  console.log(
    'Matched from Q1 bonus report (additional):',
    fromBonus.filter((id) => !fromCommSet.has(id)).length
  );
  console.log('Total unique entries to mark paid:', paidIds.size);

  if (unmatchedComm.length) {
    console.log('\n--- Commission Excel rows with NO database match (fix data or ignore) ---');
    unmatchedComm.slice(0, 30).forEach((l) => console.log(' ', l));
    if (unmatchedComm.length > 30) console.log(`  ... +${unmatchedComm.length - 30} more`);
  }
  if (unmatchedBonus.length) {
    console.log('\n--- Bonus Excel rows with NO database match (key client|deal|payable|attributed) ---');
    unmatchedBonus.slice(0, 20).forEach((l) => console.log(' ', l));
    if (unmatchedBonus.length > 20) console.log(`  ... +${unmatchedBonus.length - 20} more`);
  }

  const applySupabase =
    APPLY &&
    paidIds.size > 0 &&
    (process.env.MARK_PAID_SUPABASE === '1' || process.env.MARK_PAID_SUPABASE === 'true');

  if (APPLY && paidIds.size > 0) {
    const upd = db.prepare(`UPDATE commission_entries SET status = 'paid', updated_at = datetime('now') WHERE id = ?`);
    for (const id of paidIds) {
      upd.run(id);
    }
    console.log('\n✓ Local SQLite: updated status to PAID for', paidIds.size, 'entries.');

    if (applySupabase) {
      const sup = await updateSupabasePaid(Array.from(paidIds));
      if (sup.ok) {
        console.log('✓ Supabase: updated the same', paidIds.size, 'entry ids to paid.');
      } else {
        console.error('✗ Supabase update failed:', sup.error);
        console.error('  Fix env (service role key) or run again; local.db was already updated.');
      }
    } else if (process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.USE_LOCAL_DB) {
      console.log(
        '\nNote: NEXT_PUBLIC_SUPABASE_URL is set but USE_LOCAL_DB is not true — the app usually reads Supabase.',
        'Re-run with MARK_PAID_SUPABASE=1 and SUPABASE_SERVICE_ROLE_KEY to update cloud, or set USE_LOCAL_DB=true to use local.db.'
      );
    }
  } else if (!APPLY) {
    console.log('\n(Dry-run: no DB updates. Set MARK_PAID_APPLY=1 to apply.)\n');
  }

  // paid → payable for same BDR/month when id not in sheet+bonus match set
  const strictRevertedIds: string[] = [];
  if (STRICT_SHEET && paidIds.size > 0) {
    const candidates = db
      .prepare(
        `
      SELECT id FROM commission_entries
      WHERE bdr_id = ? AND status = 'paid'
        AND strftime('%Y-%m', COALESCE(payable_date, accrual_date, month || '-01')) = ?
    `
      )
      .all(bdrId, UNPAID_MONTH) as { id: string }[];
    const toRevert = candidates.map((c) => c.id).filter((id) => !paidIds.has(id));
    strictRevertedIds.push(...toRevert);
    if (APPLY && toRevert.length > 0) {
      const rev = db.prepare(
        `UPDATE commission_entries SET status = 'payable', updated_at = datetime('now') WHERE id = ?`
      );
      for (const id of toRevert) {
        rev.run(id);
      }
      console.log(
        '\n✓ Strict sheet reconcile:',
        toRevert.length,
        'entries set paid → payable (in',
        UNPAID_MONTH,
        'but not on matched sheet/bonus lines).'
      );
    } else if (APPLY && toRevert.length === 0) {
      console.log('\n✓ Strict sheet reconcile: no extra `paid` rows in', UNPAID_MONTH, 'outside the match set.');
    } else if (!APPLY && toRevert.length > 0) {
      console.log(
        '\n(Dry-run STRICT: would revert',
        toRevert.length,
        'paid → payable in',
        UNPAID_MONTH,
        '— set MARK_PAID_APPLY=1 to apply.)'
      );
    }
  } else if (STRICT_SHEET && paidIds.size === 0) {
    console.warn(
      '\nSTRICT_SHEET_RECONCILE skipped: zero matched rows from Excel/bonus (avoids reverting all paid in month).'
    );
  }

  // --- Still not paid: March by payable month ---
  const unpaidMarch = db
    .prepare(
      `
    SELECT ce.id, ce.amount, ce.status, ce.payable_date,
           d.client_name,
           COALESCE(ds.service_name, d.service_type) as deal_label
    FROM commission_entries ce
    JOIN deals d ON ce.deal_id = d.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
    WHERE ce.bdr_id = ?
      AND ce.status != 'cancelled'
      AND strftime('%Y-%m', COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01')) = ?
      AND ce.status != 'paid'
    ORDER BY ce.payable_date
  `
    )
    .all(bdrId, UNPAID_MONTH) as Array<{
    id: string;
    amount: number;
    status: string;
    payable_date: string;
    client_name: string;
    deal_label: string;
  }>;

  console.log(`\n--- Still NOT paid (${UNPAID_MONTH} payable month, status ≠ paid) — ${unpaidMarch.length} rows ---`);
  let unpaidTotal = 0;
  for (const u of unpaidMarch) {
    const a = Number(u.amount ?? 0);
    unpaidTotal += a;
    console.log(
      `  ${u.payable_date?.slice(0, 10) ?? '—'} | ${u.client_name} | ${u.deal_label} | $${a.toFixed(2)} | ${u.status}`
    );
  }
  console.log(`  Subtotal (March unpaid, DB amounts): $${unpaidTotal.toFixed(2)}`);

  const reportDir = resolve(process.cwd(), 'reports');
  try {
    mkdirSync(reportDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const reportPath = resolve(reportDir, `unpaid-${UNPAID_MONTH}-after-excel-mark-paid.txt`);
  const lines = [
    `BDR: ${bdrId}`,
    `Month filter: ${UNPAID_MONTH}`,
    `Excel source: ${commissionOnly ? 'commission report only' : 'commission + Q1 bonus'}`,
    `Marked paid (unique entry ids): ${paidIds.size}`,
    STRICT_SHEET
      ? `Strict sheet reconcile (paid → payable, not on sheet): ${strictRevertedIds.length} ids`
      : 'Strict sheet reconcile: off',
    ...(STRICT_SHEET && strictRevertedIds.length
      ? ['', 'Reverted entry ids:', ...strictRevertedIds]
      : []),
    '',
    `Still not paid (${unpaidMarch.length} lines):`,
    ...unpaidMarch.map(
      (u) =>
        `${u.payable_date?.slice(0, 10)}\t${u.client_name}\t${u.deal_label}\t${Number(u.amount ?? 0).toFixed(2)}\t${u.status}`
    ),
    '',
    `Subtotal: ${unpaidTotal.toFixed(2)}`,
  ];
  writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log('\nWrote:', reportPath);
  console.log('');
}

void main();
