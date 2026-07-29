/**
 * Link live commission_entries to approved/paid batches using frozen snapshots.
 * Run after importing commission Excel reports so the Commission page reflects approvals.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/sync-entries-from-approved-batches.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

import type { ExportRow } from '../lib/commission/export-rows';

type SnapshotRow = ExportRow & {
  client_name: string;
  deal?: string;
  payable_date: string;
  final_invoiced_amount: string | number;
  original_commission?: string | number;
};

function norm(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseAmount(v: string | number | undefined): number {
  return parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
}

function snapshotRowsFromJson(raw: string): SnapshotRow[] {
  const parsed = JSON.parse(raw) as SnapshotRow[] | { rows?: SnapshotRow[] };
  const rows = Array.isArray(parsed) ? parsed : parsed.rows ?? [];
  return rows.filter((r) => {
    const name = String(r.client_name ?? '').trim();
    if (!name || name === 'Client' || name === 'TOTAL') return false;
    if (name.includes('—') && name.includes('$')) return false;
    return !!r.payable_date && parseAmount(r.final_invoiced_amount || r.original_commission) > 0;
  });
}

type CeCandidate = {
  id: string;
  deal_id: string;
  ce_amount: number;
  payable_date: string;
  client_name: string;
  deal_label: string;
};

function findCommissionEntry(
  db: ReturnType<typeof import('../lib/db/local-db').getLocalDB>,
  bdrId: string,
  row: SnapshotRow
): CeCandidate | null {
  const pd = String(row.payable_date).slice(0, 10);
  const amount = parseAmount(row.final_invoiced_amount || row.original_commission);
  const client = String(row.client_name).trim();

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
      AND substr(COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01'), 1, 10) = ?
      AND trim(d.client_name) = trim(?)
  `
    )
    .all(bdrId, pd, client) as CeCandidate[];

  if (raw.length === 0) {
    // Relaxed: same client + amount within month
    const month = pd.slice(0, 7);
    const relaxed = db
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
        AND strftime('%Y-%m', COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01')) = ?
        AND trim(d.client_name) = trim(?)
        AND ABS(ce.amount - ?) < 0.02
    `
      )
      .all(bdrId, month, client, amount) as CeCandidate[];
    if (relaxed.length === 1) return relaxed[0];
    return null;
  }

  if (raw.length === 1) return raw[0];

  const dealN = norm(String(row.deal ?? ''));
  let best: CeCandidate | null = null;
  let bestScore = -1;
  for (const c of raw) {
    const label = norm(c.deal_label);
    let score = 0;
    if (dealN && label === dealN) score += 100;
    else if (dealN && (label.includes(dealN) || dealN.includes(label))) score += 50;
    const amtDiff = Math.abs(Number(c.ce_amount ?? 0) - amount);
    if (amtDiff < 0.02) score += 40;
    else if (amtDiff < 1) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

async function main() {
  const { getLocalDB } = await import('../lib/db/local-db');
  const { generateUUID } = await import('../lib/utils/uuid');
  const { invalidateApprovalLockCache } = await import('../lib/commission/approval-lock-store');
  const { buildLocalBillableFilterContext, filterBillableEntries } = await import(
    '../lib/commission/filter-billable-entries'
  );

  const db = getLocalDB();

  const batches = db
    .prepare(
      `
    SELECT cb.id, cb.bdr_id, cb.run_date, cb.status
    FROM commission_batches cb
    WHERE cb.status IN ('approved', 'paid')
    ORDER BY cb.run_date
  `
    )
    .all() as Array<{ id: string; bdr_id: string; run_date: string; status: string }>;

  const fpExists = db.prepare(`
    SELECT 1 FROM approved_commission_fingerprints
    WHERE bdr_id = ? AND deal_id = ? AND substr(effective_date,1,10) = ? AND ABS(amount - ?) < 0.02
    LIMIT 1
  `);

  const insertFp = db.prepare(`
    INSERT INTO approved_commission_fingerprints (id, bdr_id, deal_id, effective_date, amount, batch_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO commission_batch_items (id, batch_id, commission_entry_id)
    VALUES (?, ?, ?)
  `);

  const updateEntry = db.prepare(`
    UPDATE commission_entries
    SET invoiced_batch_id = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  let linked = 0;
  let batchItems = 0;
  let fingerprints = 0;
  let markedPaid = 0;
  let unmatched = 0;
  const usedEntryIds = new Set<string>();

  for (const batch of batches) {
    const snap = db
      .prepare('SELECT snapshot_data FROM commission_batch_snapshots WHERE batch_id = ?')
      .get(batch.id) as { snapshot_data: string } | undefined;

    if (!snap?.snapshot_data) {
      console.log(`Skip ${batch.run_date} ${batch.status}: no snapshot`);
      continue;
    }

    const rows = snapshotRowsFromJson(snap.snapshot_data);
    console.log(`\n${batch.run_date} ${batch.status} — ${rows.length} snapshot row(s)`);

    for (const row of rows) {
      const ce = findCommissionEntry(db, batch.bdr_id, row);
      const amount = parseAmount(row.final_invoiced_amount || row.original_commission);
      const eff = String(row.payable_date).slice(0, 10);

      if (!ce) {
        unmatched++;
        console.log(`  ⊗ no entry: ${row.client_name} $${amount.toFixed(2)} ${eff}`);
        continue;
      }

      if (usedEntryIds.has(ce.id)) continue;
      usedEntryIds.add(ce.id);

      const current = db
        .prepare('SELECT status FROM commission_entries WHERE id = ?')
        .get(ce.id) as { status: string };

      const newStatus =
        batch.status === 'paid' ? 'paid' : current.status === 'paid' ? 'paid' : current.status;

      updateEntry.run(batch.id, newStatus, ce.id);
      if (batch.status === 'paid' && current.status !== 'paid') markedPaid++;

      insertItem.run(generateUUID(), batch.id, ce.id);
      batchItems++;
      linked++;

      if (!fpExists.get(batch.bdr_id, ce.deal_id, eff, amount)) {
        insertFp.run(generateUUID(), batch.bdr_id, ce.deal_id, eff, amount, batch.id);
        fingerprints++;
      }
    }
  }

  console.log('\n=== Sync summary ===');
  console.log(`Entries linked: ${linked}`);
  console.log(`Batch items ensured: ${batchItems}`);
  console.log(`Fingerprints added: ${fingerprints}`);
  console.log(`Marked paid: ${markedPaid}`);
  console.log(`Unmatched snapshot rows: ${unmatched}`);

  // Clean draft batch of settled lines
  const draft = db
    .prepare("SELECT id FROM commission_batches WHERE status = 'draft' ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string } | undefined;

  if (draft) {
    const billableCtx = buildLocalBillableFilterContext(db);
    const items = db
      .prepare(
        `
      SELECT cbi.id as item_id, ce.id, ce.bdr_id, ce.deal_id, ce.amount, ce.payable_date, ce.accrual_date, ce.month, ce.status
      FROM commission_batch_items cbi
      JOIN commission_entries ce ON ce.id = cbi.commission_entry_id
      WHERE cbi.batch_id = ?
    `
      )
      .all(draft.id) as any[];

    const remove = items.filter((item) => !filterBillableEntries([item], billableCtx).length);
    const delItem = db.prepare('DELETE FROM commission_batch_items WHERE id = ?');
    const clearInv = db.prepare(
      "UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = datetime('now') WHERE id = ?"
    );
    for (const item of remove) {
      delItem.run(item.item_id);
      clearInv.run(item.id);
    }
    console.log(`Removed ${remove.length} settled line(s) from draft ${draft.id.slice(0, 8)}`);
  }

  invalidateApprovalLockCache();

  const { getLocalApprovalContext, isEntryApprovedForDisplay } = await import(
    '../lib/commission/entry-approval-display'
  );
  const ctx = getLocalApprovalContext(db);
  const entries = db.prepare('SELECT id, deal_id, amount, payable_date, accrual_date, month, status, bdr_id FROM commission_entries').all() as any[];
  let approved = 0;
  let pending = 0;
  for (const e of entries) {
    if (isEntryApprovedForDisplay(e, ctx)) approved++;
    else pending++;
  }
  console.log(`\nDisplay: ${approved} approved/settled, ${pending} pending (of ${entries.length} entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
