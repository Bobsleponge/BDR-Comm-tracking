/**
 * Full commission structure repair:
 * 1) Dedupe fingerprints
 * 2) Safe-reprocess every active closed-won deal (preserves approved locks)
 * 3) Relink + dedupe entries per deal
 * 4) Sync batch items from approved snapshots
 * 5) Sync approval settlement status
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/repair-all-commission-structure.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { getLocalDB } = await import('../lib/db/local-db');
  const { safeReprocessDeal } = await import('../lib/commission/safe-reprocess');
  const { relinkCommissionEntriesForDeal, removeDuplicateCommissionEntries, removeDuplicateEntriesPerRevenueEvent } =
    await import('../lib/commission/relink-commission-entries');
  const { amountKey } = await import('../lib/commission/approval-lock');
  const db = getLocalDB();

  console.log('=== Step 1: Dedupe fingerprints ===');
  const delFp = db.prepare('DELETE FROM approved_commission_fingerprints WHERE id = ?');
  let removedFp = 0;
  for (;;) {
    const rows = db
      .prepare('SELECT id, deal_id, effective_date, amount FROM approved_commission_fingerprints')
      .all() as Array<{ id: string; deal_id: string; effective_date: string; amount: number }>;
    const seen = new Set<string>();
    const toDelete: string[] = [];
    for (const fp of rows) {
      const key = `${fp.deal_id}|${amountKey(fp.amount)}|${String(fp.effective_date).slice(0, 10)}`;
      if (seen.has(key)) toDelete.push(fp.id);
      else seen.add(key);
    }
    if (!toDelete.length) break;
    for (const id of toDelete) delFp.run(id);
    removedFp += toDelete.length;
  }
  console.log(`Removed ${removedFp} duplicate fingerprint(s)`);

  const deals = db
    .prepare(
      `SELECT id, client_name FROM deals
       WHERE status = 'closed-won' AND cancellation_date IS NULL AND first_invoice_date IS NOT NULL
       ORDER BY client_name`
    )
    .all() as Array<{ id: string; client_name: string }>;

  console.log(`\n=== Step 2: Safe-reprocess ${deals.length} deals ===`);
  let totalRelinked = 0;
  let totalDupes = 0;
  let errors = 0;

  for (const deal of deals) {
    try {
      const result = await safeReprocessDeal(deal.id);
      totalRelinked += result.relinked ?? 0;
      totalDupes += result.duplicatesRemoved ?? 0;
      if (
        (result.unlinkedEntries ?? 0) > 0 ||
        (result.orphanRevenueEvents ?? 0) > 0 ||
        (result.relinked ?? 0) > 0
      ) {
        console.log(
          `  ${deal.client_name}: events ${result.eventsProcessed}, preserved ${result.preservedEntryCount}, ` +
            `relinked ${result.relinked ?? 0}, unlinked ${result.unlinkedEntries ?? 0}, orphan rev ${result.orphanRevenueEvents ?? 0}`
        );
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ ${deal.client_name}: ${(err as Error).message}`);
    }
  }

  console.log(`\n=== Step 3: Final relink pass ===`);
  let stillUnlinked = 0;
  let stillOrphan = 0;
  for (const deal of deals) {
    removeDuplicateCommissionEntries(db, deal.id);
    removeDuplicateEntriesPerRevenueEvent(db, deal.id);
    const relink = relinkCommissionEntriesForDeal(db, deal.id);
    totalRelinked += relink.linked;
    stillUnlinked += relink.unlinkedEntries;
    stillOrphan += relink.orphanRevenueEvents;
  }
  console.log(`Relinked ${totalRelinked} entries total; remaining unlinked ${stillUnlinked}, orphan rev ${stillOrphan}`);

  console.log('\n=== Step 4: Sync batch items from snapshots ===');
  const { execSync } = await import('child_process');
  execSync('npx tsx scripts/sync-entries-from-approved-batches.ts', {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, USE_LOCAL_DB: 'true' },
  });

  console.log('\n=== Step 5: Sync approval settlement ===');
  const { syncApprovalSettlementForAllDeals } = await import('../lib/commission/sync-approval-settlement');
  const { invalidateApprovalLockCache } = await import('../lib/commission/approval-lock-store');
  invalidateApprovalLockCache();
  const sync = await syncApprovalSettlementForAllDeals();
  console.log(`Marked paid: ${sync.reduce((s, r) => s + r.markedPaid, 0)}`);

  console.log('\n=== Done ===');
  console.log(`Deals processed: ${deals.length}, errors: ${errors}, dupes removed: ${totalDupes}`);
  if (stillUnlinked > 0 || stillOrphan > 0) {
    console.log(`WARNING: ${stillUnlinked} unlinked entries, ${stillOrphan} orphan revenue events remain`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
