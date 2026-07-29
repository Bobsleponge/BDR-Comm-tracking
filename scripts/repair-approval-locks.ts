/**
 * Repair approval locks after deal edits:
 * 1) Dedupe approved_commission_fingerprints
 * 2) Remove settled entries from draft batches
 * 3) Sync paid status on entries matching paid-batch fingerprints
 * 4) Safe-reprocess all deals that have fingerprints (optional)
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/repair-approval-locks.ts
 * Skip reprocess: SKIP_REPROCESS=1 USE_LOCAL_DB=true npx tsx scripts/repair-approval-locks.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

// Full reprocess is opt-in only — it rebuilds all deals and can disrupt data if misconfigured
const RUN_REPROCESS = process.env.RUN_REPROCESS === '1' || process.env.RUN_REPROCESS === 'true';

async function main() {
  const { getLocalDB } = await import('../lib/db/local-db');
  const { amountKey } = await import('../lib/commission/approval-lock');
  const { buildLocalBillableFilterContext, filterBillableEntries } = await import(
    '../lib/commission/filter-billable-entries'
  );
  const db = getLocalDB();

  console.log('=== Step 1: Dedupe fingerprints ===');
  const allFp = db.prepare(`
    SELECT acf.id, acf.bdr_id, acf.deal_id, acf.effective_date, acf.amount, acf.batch_id, cb.status as batch_status
    FROM approved_commission_fingerprints acf
    LEFT JOIN commission_batches cb ON cb.id = acf.batch_id
  `).all() as any[];

  let removedTotal = 0;
  const del = db.prepare('DELETE FROM approved_commission_fingerprints WHERE id = ?');
  for (;;) {
    const rows = db.prepare(`
      SELECT acf.id, acf.deal_id, acf.effective_date, acf.amount
      FROM approved_commission_fingerprints acf
    `).all() as Array<{ id: string; deal_id: string; effective_date: string; amount: number }>;

    const seen = new Set<string>();
    const toDelete: string[] = [];
    for (const fp of rows) {
      const key = `${fp.deal_id}|${amountKey(fp.amount)}|${String(fp.effective_date).slice(0, 10)}`;
      if (seen.has(key)) toDelete.push(fp.id);
      else seen.add(key);
    }
    if (toDelete.length === 0) break;
    for (const id of toDelete) del.run(id);
    removedTotal += toDelete.length;
  }

  const kept = (db.prepare('SELECT COUNT(*) as c FROM approved_commission_fingerprints').get() as { c: number }).c;
  if (removedTotal > 0) {
    console.log(`Removed ${removedTotal} duplicate fingerprint(s); kept ${kept}`);
  } else {
    console.log(`No duplicate fingerprints (${kept} rows)`);
  }

  console.log('\n=== Step 2: Clean draft batches of settled entries ===');
  const billableCtx = buildLocalBillableFilterContext(db);
  const drafts = db.prepare(`SELECT id FROM commission_batches WHERE status = 'draft'`).all() as Array<{ id: string }>;

  let removedFromDrafts = 0;
  for (const { id: batchId } of drafts) {
    const items = db.prepare(`
      SELECT cbi.id as item_id, ce.id, ce.bdr_id, ce.deal_id, ce.amount, ce.payable_date, ce.accrual_date, ce.month, ce.status
      FROM commission_batch_items cbi
      JOIN commission_entries ce ON ce.id = cbi.commission_entry_id
      WHERE cbi.batch_id = ?
    `).all(batchId) as any[];

    const settled = items.filter((item) => !filterBillableEntries([item], billableCtx).length);
    if (settled.length === 0) continue;

    const delItem = db.prepare('DELETE FROM commission_batch_items WHERE id = ?');
    const clearInv = db.prepare(`UPDATE commission_entries SET invoiced_batch_id = NULL WHERE id = ?`);
    for (const item of settled) {
      delItem.run(item.item_id);
      clearInv.run(item.id);
      removedFromDrafts++;
      console.log(`  Removed from draft ${batchId.slice(0, 8)}: deal ${item.deal_id.slice(0, 8)} $${item.amount}`);
    }
  }
  console.log(`Removed ${removedFromDrafts} settled item(s) from draft batch(es)`);

  console.log('\n=== Step 3: Sync paid status from locks ===');
  const { syncApprovalSettlementForAllDeals } = await import('../lib/commission/sync-approval-settlement');
  const { invalidateApprovalLockCache } = await import('../lib/commission/approval-lock-store');
  invalidateApprovalLockCache();
  const syncResults = await syncApprovalSettlementForAllDeals();
  const totalPaid = syncResults.reduce((s, r) => s + r.markedPaid, 0);
  console.log(`Marked ${totalPaid} entries as paid`);

  if (RUN_REPROCESS) {
    console.log('\n=== Step 4: Safe-reprocess deals with fingerprints (RUN_REPROCESS=1) ===');
    const { safeReprocessDeal } = await import('../lib/commission/safe-reprocess');
    const dealIds = db.prepare('SELECT DISTINCT deal_id FROM approved_commission_fingerprints').all() as Array<{ deal_id: string }>;
    for (const { deal_id } of dealIds) {
      const deal = db.prepare('SELECT client_name FROM deals WHERE id = ?').get(deal_id) as { client_name: string } | undefined;
      try {
        const result = await safeReprocessDeal(deal_id);
        console.log(
          `  ${deal?.client_name ?? deal_id}: preserved ${result.preservedEntryCount}, ` +
            `deleted ${result.deletedEntryCount}, events ${result.eventsProcessed}`
        );
      } catch (err) {
        console.error(`  Failed ${deal?.client_name ?? deal_id}:`, (err as Error).message);
      }
    }
  } else {
    console.log('\n=== Step 4: Skipped (set RUN_REPROCESS=1 to rebuild all fingerprinted deals) ===');
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
