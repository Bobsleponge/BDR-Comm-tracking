/**
 * Safe-reprocess all deals that have approved commission fingerprints.
 * Preserves locked months; rebuilds open commission entries from current deal data.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/safe-reprocess-deals-with-approved.ts
 * Dry run: DRY_RUN=1 USE_LOCAL_DB=true npx tsx scripts/safe-reprocess-deals-with-approved.ts
 */

import Module from 'node:module';

// Allow importing server-only commission modules from scripts
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function main() {
  const { safeReprocessDeal } = await import('../lib/commission/safe-reprocess');
  const { getLocalDB } = await import('../lib/db/local-db');
  const db = getLocalDB();

  const dealIds = db.prepare(`
    SELECT DISTINCT deal_id FROM approved_commission_fingerprints ORDER BY deal_id
  `).all() as Array<{ deal_id: string }>;

  if (dealIds.length === 0) {
    console.log('No deals with approved fingerprints found.');
    return;
  }

  console.log(`Found ${dealIds.length} deal(s) with approved fingerprints.\n`);

  for (const { deal_id: dealId } of dealIds) {
    const deal = db.prepare('SELECT client_name FROM deals WHERE id = ?').get(dealId) as { client_name: string } | undefined;
    const label = deal?.client_name ?? dealId;

    if (DRY_RUN) {
      const fpCount = db.prepare('SELECT COUNT(*) as c FROM approved_commission_fingerprints WHERE deal_id = ?').get(dealId) as { c: number };
      console.log(`[DRY RUN] Would safe-reprocess: ${label} (${fpCount.c} locked month(s))`);
      continue;
    }

    try {
      const result = await safeReprocessDeal(dealId);
      console.log(
        `Reprocessed ${label}: ${result.eventsProcessed} events, ` +
          `preserved ${result.preservedEntryCount} entries, ` +
          `deleted ${result.deletedEntryCount}, ` +
          `skipped months: ${result.skippedMonths.join(', ') || '(none)'}`
      );
    } catch (err) {
      console.error(`Failed ${label}:`, (err as Error).message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
