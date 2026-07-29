/**
 * Audit a deal after edit: compare approved fingerprints vs live entries per month.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/reconcile-deal-after-edit.ts [deal_id]
 * All deals with fingerprints: USE_LOCAL_DB=true npx tsx scripts/reconcile-deal-after-edit.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { reconcileDeal } = await import('../lib/commission/reconcile-deal');
  const { getLocalDB } = await import('../lib/db/local-db');
  const db = getLocalDB();

  const dealIdArg = process.argv[2];
  const dealIds = dealIdArg
    ? [{ deal_id: dealIdArg }]
    : (db.prepare(`
        SELECT DISTINCT deal_id FROM approved_commission_fingerprints ORDER BY deal_id
      `).all() as Array<{ deal_id: string }>);

  for (const { deal_id: dealId } of dealIds) {
    const result = await reconcileDeal(dealId);
    if (!result) {
      console.log(`Deal not found: ${dealId}\n`);
      continue;
    }

    console.log(`\n=== ${result.clientName} (${result.dealId}) ===`);
    console.log(`Approved total: $${result.approvedTotal.toFixed(2)} | Live total: $${result.liveTotal.toFixed(2)}`);

    if (result.eligibleWouldIncludeLockedMonths.length > 0) {
      console.log(`WARNING: Live entries exist for locked months: ${result.eligibleWouldIncludeLockedMonths.join(', ')}`);
      console.log('(Fingerprints still block billing; safe-reprocess removes phantom open-month duplicates.)');
    }

    console.log('Month       | Approved   | Live       | Blocks billing | Delta');
    console.log('------------|------------|------------|----------------|-------');
    for (const row of result.rows) {
      const approved = row.approvedAmount != null ? `$${row.approvedAmount.toFixed(2)}` : '-';
      const live = row.liveEntryAmount != null ? `$${row.liveEntryAmount.toFixed(2)}` : '-';
      const delta = row.delta != null ? `$${row.delta.toFixed(2)}` : '-';
      console.log(
        `${row.month.padEnd(11)} | ${approved.padStart(10)} | ${live.padStart(10)} | ${row.fingerprintBlocksBilling ? 'yes' : 'no '.padEnd(14)} | ${delta}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
