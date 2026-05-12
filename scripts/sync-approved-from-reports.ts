/**
 * Sync local DB from approved commission + quarterly bonus Excel exports.
 *
 * Commission report:
 * - Match each row to a commission_entry (BDR + client + payable_date + deal + amount).
 * - Ensure approved_commission_fingerprint exists; link entry to commission batch (invoiced_batch_id).
 * - Entries on DRAFT batches for this BDR that are NOT in the Excel → clear invoiced_batch_id (awaiting a new report).
 *
 * Quarterly Q1 payable report:
 * - Lines in Excel = approved for Q1 bonus attribution.
 * - Commission entries with payable_date in Q1 that participate in bonus calc but are NOT in Excel
 *   → payable_date moved to Q2_START (default first day of Q2 2026).
 *
 * Usage:
 *   SYNC_APPLY=1 npx tsx scripts/sync-approved-from-reports.ts
 *   COMMISSION_XLSX=... BONUS_XLSX=... BDR_ID=test-bdr-id COMMISSION_BATCH_ID=... SYNC_APPLY=1
 *
 * Without SYNC_APPLY=1 → dry-run only.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as XLSX from 'xlsx';
import { format } from 'date-fns';
import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';
import { attributedRevenueFromEntry } from '../lib/dashboard/quarterly-bonus-export';
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

const APPLY = process.env.SYNC_APPLY === '1' || process.env.SYNC_APPLY === 'true';
const Q2_PAYABLE_DATE = process.env.Q2_PAYABLE_DATE || '2026-04-01';

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

function findCommissionEntry(db: ReturnType<typeof getLocalDB>, bdrId: string, r: CommRow): CeCandidate | null {
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
      AND trim(d.client_name) = trim(?)
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

function fetchQ1BonusEntriesWithIds(
  db: ReturnType<typeof getLocalDB>,
  bdrId: string,
  quarterStart: string,
  quarterEnd: string
): Array<
  CeCandidate & {
    re_id: string | null;
    amount_collected: number | null;
    attributed_revenue: number;
  }
> {
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
    ORDER BY ce.payable_date, ce.id
  `
    )
    .all(bdrId, quarterStart, quarterEnd) as Array<{
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
    const rev = attributedRevenueFromEntry(
      Number(r.ce_amount ?? 0),
      r.re_id,
      r.amount_collected
    );
    return {
      id: r.id,
      deal_id: r.deal_id,
      ce_amount: Number(r.ce_amount ?? 0),
      payable_date: (r.payable_date || '').split('T')[0],
      client_name: r.client_name ?? '',
      deal_label: r.service_name || r.service_type || 'Deal',
      re_id: r.re_id,
      amount_collected: r.amount_collected,
      attributed_revenue: rev,
    };
  });
}

function main() {
  const commissionPath =
    process.env.COMMISSION_XLSX || resolve(process.cwd(), 'commission-report-2026-03-31-d5bb2eef.xlsx');
  const bonusPath =
    process.env.BONUS_XLSX ||
    resolve(process.cwd(), 'quarterly-bonus-report-2026-Q1-payable-2026-03-31 (3).xlsx');

  if (!existsSync(commissionPath)) {
    console.error('Commission Excel not found:', commissionPath);
    process.exit(1);
  }
  if (!existsSync(bonusPath)) {
    console.error('Bonus Excel not found:', bonusPath);
    process.exit(1);
  }

  const db = getLocalDB();
  const commRows = parseCommissionExcel(commissionPath);
  const { bdr: bdrFromBonus, rows: bonusRows } = parseBonusExcel(bonusPath);
  const bdrId = process.env.BDR_ID || bdrFromBonus || 'test-bdr-id';

  let batchId =
    process.env.COMMISSION_BATCH_ID ||
    (db.prepare(`SELECT id FROM commission_batches WHERE id LIKE 'd5bb2eef%' LIMIT 1`).get() as { id: string } | undefined)?.id;

  if (!batchId) {
    batchId = (db.prepare(`SELECT id FROM commission_batches WHERE run_date = '2026-03-31' ORDER BY created_at DESC LIMIT 1`).get() as { id: string } | undefined)?.id;
  }

  console.log('\n=== sync-approved-from-reports ===\n');
  console.log('APPLY:', APPLY);
  console.log('BDR_ID:', bdrId);
  console.log('COMMISSION_BATCH_ID:', batchId || '(will create if APPLY)');
  console.log('Commission rows:', commRows.length);
  console.log('Bonus rows:', bonusRows.length);
  console.log('Q2 payable date for moved entries:', Q2_PAYABLE_DATE);

  const fpExists = db.prepare(`
    SELECT 1 FROM approved_commission_fingerprints
    WHERE bdr_id = ? AND deal_id = ? AND substr(effective_date,1,10) = ? AND ABS(amount - ?) < 0.02
    LIMIT 1
  `);

  const insertFp = db.prepare(`
    INSERT INTO approved_commission_fingerprints (id, bdr_id, deal_id, effective_date, amount, batch_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const matchedCommissionEntryIds = new Set<string>();

  // --- Create batch if needed ---
  if (!batchId && APPLY) {
    batchId = generateUUID();
    db.prepare(
      `INSERT INTO commission_batches (id, bdr_id, run_date, status) VALUES (?, ?, '2026-03-31', 'approved')`
    ).run(batchId, bdrId);
    console.log('Created approved commission_batches row:', batchId);
  }

  let batchIdResolved = batchId;

  // --- Commission report sync ---
  let fpInserted = 0;
  let fpSkipped = 0;
  let unmatchedComm = 0;
  let linkUpdated = 0;

  if (!batchIdResolved) {
    console.log(
      '\nSkipping commission batch sync: no batch id (set COMMISSION_BATCH_ID or run SYNC_APPLY=1 to auto-create). Quarterly Q2 moves still run.\n'
    );
  } else {
    if (APPLY) {
      db.prepare(`UPDATE commission_batches SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(
        batchIdResolved
      );
    }

    for (const r of commRows) {
      const ce = findCommissionEntry(db, bdrId, r);
      if (!ce) {
        unmatchedComm++;
        console.log('  ⊗ No CE match:', r.client_name, r.payable_date, r.deal, r.final_invoiced_amount);
        continue;
      }
      matchedCommissionEntryIds.add(ce.id);
      const eff = r.payable_date.slice(0, 10);
      const amt = r.final_invoiced_amount;

      if (fpExists.get(bdrId, ce.deal_id, eff, amt)) {
        fpSkipped++;
      } else if (APPLY) {
        insertFp.run(generateUUID(), bdrId, ce.deal_id, eff, amt, batchIdResolved);
        fpInserted++;
      }

      if (APPLY) {
        db.prepare(`UPDATE commission_entries SET invoiced_batch_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
          batchIdResolved,
          ce.id
        );
        db.prepare(
          `INSERT OR IGNORE INTO commission_batch_items (id, batch_id, commission_entry_id) VALUES (?, ?, ?)`
        ).run(generateUUID(), batchIdResolved, ce.id);
        linkUpdated++;
      }
    }

    console.log('\nCommission sync: fingerprints inserted', fpInserted, 'skipped(existing)', fpSkipped, 'unmatched', unmatchedComm);
    if (APPLY) console.log('Commission sync: invoiced_batch_id set + batch_items ensured:', linkUpdated);
  }

  // Clear draft batch links for entries not in commission Excel
  const draftUnlinked = db
    .prepare(
      `
    SELECT ce.id FROM commission_entries ce
    JOIN commission_batches cb ON ce.invoiced_batch_id = cb.id
    WHERE ce.bdr_id = ? AND cb.status = 'draft'
  `
    )
    .all(bdrId) as { id: string }[];

  let cleared = 0;
  for (const { id } of draftUnlinked) {
    if (matchedCommissionEntryIds.has(id)) continue;
    if (APPLY) {
      db.prepare(`DELETE FROM commission_batch_items WHERE commission_entry_id = ? AND batch_id IN (
        SELECT id FROM commission_batches WHERE status = 'draft' AND bdr_id = ?
      )`).run(id, bdrId);
      db.prepare(`UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
      cleared++;
    }
  }
  console.log('Draft batch entries not in commission Excel:', draftUnlinked.filter((d) => !matchedCommissionEntryIds.has(d.id)).length, APPLY ? `(cleared ${cleared})` : '(dry-run)');

  // --- Quarterly Q1: move non-approved lines to Q2 ---
  const { start, end } = parseQuarter('2026-Q1');
  const q1Start = format(start, 'yyyy-MM-dd');
  const q1End = format(end, 'yyyy-MM-dd');
  const q1Entries = fetchQ1BonusEntriesWithIds(db, bdrId, q1Start, q1End);

  const approvedBonusKeys = new Set(bonusRows.map((r) => bonusKey(r.client_name, r.deal, r.payable_date, r.attributed_revenue)));

  const toMove: string[] = [];
  for (const e of q1Entries) {
    const k = bonusKey(e.client_name, e.deal_label, e.payable_date, e.attributed_revenue);
    if (!approvedBonusKeys.has(k)) {
      toMove.push(e.id);
    }
  }

  console.log('\nQ1 bonus participants (DB):', q1Entries.length);
  console.log('Approved in quarterly Excel (keys):', approvedBonusKeys.size);
  console.log('Entries to move to Q2 payable_date:', toMove.length, APPLY ? '(applying)' : '(dry-run)');
  if (toMove.length && !APPLY) {
    console.log('  Sample ids:', toMove.slice(0, 5).join(', '));
  }

  if (APPLY && toMove.length) {
    const upd = db.prepare(`UPDATE commission_entries SET payable_date = ?, updated_at = datetime('now') WHERE id = ?`);
    for (const id of toMove) {
      upd.run(Q2_PAYABLE_DATE, id);
    }
  }

  console.log('\nDone. Set SYNC_APPLY=1 to write changes.\n');
}

main();
