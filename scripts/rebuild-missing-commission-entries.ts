/**
 * Create commission entries for revenue events that have no linked entry.
 * Uses approval locks so already-paid amounts are not duplicated.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/rebuild-missing-commission-entries.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { getLocalDB } = await import('../lib/db/local-db');
  const { processRevenueEvent } = await import('../lib/commission/revenue-events');
  const { getDealApprovalLocks, invalidateApprovalLockCache } = await import(
 '../lib/commission/approval-lock-store'
  );
  const db = getLocalDB();
  invalidateApprovalLockCache();

  const missing = db.prepare(`
    SELECT re.id, re.deal_id
    FROM revenue_events re
    WHERE re.commissionable = 1
      AND NOT EXISTS (SELECT 1 FROM commission_entries ce WHERE ce.revenue_event_id = re.id)
    ORDER BY re.collection_date
  `).all() as Array<{ id: string; deal_id: string }>;

  console.log(`Found ${missing.length} revenue event(s) without commission entries.`);

  const locksCache = new Map<string, Awaited<ReturnType<typeof getDealApprovalLocks>>>();
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const { id: eventId, deal_id: dealId } of missing) {
    if (!locksCache.has(dealId)) {
      locksCache.set(dealId, await getDealApprovalLocks(dealId));
    }
    const dealLocks = locksCache.get(dealId)!;
    const existingEntries = db.prepare(`
      SELECT id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status
      FROM commission_entries WHERE deal_id = ?
    `).all(dealId) as any[];

    try {
      const entryId = await processRevenueEvent(eventId, { dealLocks, existingEntries });
      if (entryId) {
        created++;
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      console.error(`Error on event ${eventId}:`, (err as Error).message);
    }
  }

  console.log(`Created ${created}, skipped (locked) ${skipped}, errors ${errors}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
