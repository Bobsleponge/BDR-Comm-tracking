/**
 * Remove commission entries from the current draft batch that fail billable filter.
 * Run: USE_LOCAL_DB=true npx tsx scripts/remove-ineligible-from-draft-batch.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { getLocalDB } = await import('../lib/db/local-db');
  const { buildLocalBillableFilterContext, isEntryBillableWithContext } = await import(
    '../lib/commission/filter-billable-entries'
  );

  const db = getLocalDB();
  const draft = db
    .prepare("SELECT id FROM commission_batches WHERE status = 'draft' ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string } | undefined;

  if (!draft) {
    console.log('No draft batch found.');
    return;
  }

  const ctx = buildLocalBillableFilterContext(db);
  const items = db
    .prepare(
      `
    SELECT cbi.id AS item_id, ce.id, ce.deal_id, ce.amount, ce.payable_date, ce.accrual_date, ce.month, ce.status, ce.bdr_id, d.client_name
    FROM commission_batch_items cbi
    JOIN commission_entries ce ON ce.id = cbi.commission_entry_id
    JOIN deals d ON d.id = ce.deal_id
    WHERE cbi.batch_id = ?
  `
    )
    .all(draft.id) as Array<{
    item_id: string;
    id: string;
    deal_id: string;
    amount: number;
    payable_date: string | null;
    accrual_date: string | null;
    month: string | null;
    status: string | null;
    bdr_id: string;
    client_name: string;
  }>;

  const remove = items.filter((item) => !isEntryBillableWithContext(item, ctx));
  console.log(`Draft ${draft.id}: ${items.length} items, removing ${remove.length} ineligible`);

  const deleteItem = db.prepare('DELETE FROM commission_batch_items WHERE id = ?');
  const clearInvoiced = db.prepare(
    "UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = datetime('now') WHERE id = ?"
  );

  for (const item of remove) {
    const month = (item.payable_date || item.accrual_date || item.month || '').slice(0, 7);
    console.log(`  - ${item.client_name} $${item.amount} (${month})`);
    deleteItem.run(item.item_id);
    clearInvoiced.run(item.id);
  }

  const remaining = db
    .prepare('SELECT COUNT(*) AS c FROM commission_batch_items WHERE batch_id = ?')
    .get(draft.id) as { c: number };
  console.log(`Remaining items: ${remaining.c}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
