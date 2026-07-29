/**
 * Add missing eligible entries to the current draft batch; remove ineligible ones.
 * Run: USE_LOCAL_DB=true npx tsx scripts/sync-draft-batch-eligible.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { getLocalDB } = await import('../lib/db/local-db');
  const { buildLocalBillableFilterContext, filterBillableEntries } = await import(
    '../lib/commission/filter-billable-entries'
  );
  const { generateUUID } = await import('../lib/utils/uuid');

  const db = getLocalDB();
  const draft = db
    .prepare("SELECT id, bdr_id FROM commission_batches WHERE status = 'draft' ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string; bdr_id: string } | undefined;

  if (!draft) {
    console.log('No draft batch.');
    return;
  }

  const billableCtx = buildLocalBillableFilterContext(db);
  const candidates = db.prepare(`
    SELECT ce.id, ce.bdr_id, ce.deal_id, ce.amount, ce.payable_date, ce.accrual_date, ce.month, ce.status
    FROM commission_entries ce
    INNER JOIN deals d ON ce.deal_id = d.id
    WHERE ce.bdr_id = ?
      AND ce.status IN ('payable', 'accrued', 'pending')
      AND COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01') <= date('now')
      AND (ce.invoiced_batch_id IS NULL OR ce.invoiced_batch_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM commission_batch_items cbi
        JOIN commission_batches cb ON cbi.batch_id = cb.id
        WHERE cbi.commission_entry_id = ce.id AND cb.status IN ('approved', 'paid')
      )
      AND d.cancellation_date IS NULL
  `).all(draft.bdr_id, draft.id) as any[];

  const eligible = filterBillableEntries(candidates, billableCtx);
  const inBatch = new Set(
    (
      db.prepare('SELECT commission_entry_id FROM commission_batch_items WHERE batch_id = ?').all(
        draft.id
      ) as { commission_entry_id: string }[]
    ).map((r) => r.commission_entry_id)
  );

  const insertItem = db.prepare(
    'INSERT INTO commission_batch_items (id, batch_id, commission_entry_id) VALUES (?, ?, ?)'
  );
  const updateEntry = db.prepare(
    'UPDATE commission_entries SET invoiced_batch_id = ?, updated_at = datetime(\'now\') WHERE id = ?'
  );

  let added = 0;
  for (const entry of eligible) {
    if (inBatch.has(entry.id)) continue;
    insertItem.run(generateUUID(), draft.id, entry.id);
    updateEntry.run(draft.id, entry.id);
    added++;
  }

  console.log(`Draft ${draft.id}: added ${added} eligible entries (${eligible.length} total eligible)`);
}

main().catch(console.error);
