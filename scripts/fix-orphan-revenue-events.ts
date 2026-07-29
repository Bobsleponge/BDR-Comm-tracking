/**
 * Create commission entries for revenue events that have no linked CE.
 * Run: USE_LOCAL_DB=true npx tsx scripts/fix-orphan-revenue-events.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { getLocalDB } = await import('../lib/db/local-db');
  const { getDealApprovalLocks } = await import('../lib/commission/approval-lock-store');
  const { processRevenueEvent } = await import('../lib/commission/revenue-events');
  const { relinkCommissionEntriesForDeal } = await import('../lib/commission/relink-commission-entries');

  const db = getLocalDB();

  const orphans = db
    .prepare(
      `
    SELECT re.id, re.deal_id, d.client_name
    FROM revenue_events re
    JOIN deals d ON d.id = re.deal_id
    WHERE d.status = 'closed-won' AND d.cancellation_date IS NULL AND re.commissionable = 1
      AND NOT EXISTS (
        SELECT 1 FROM commission_entries ce
        WHERE ce.revenue_event_id = re.id AND ce.status != 'cancelled'
      )
  `
    )
    .all() as Array<{ id: string; deal_id: string; client_name: string }>;

  if (!orphans.length) {
    console.log('No orphan revenue events.');
    return;
  }

  console.log(`Found ${orphans.length} orphan revenue event(s)`);
  const dealIds = new Set<string>();

  for (const row of orphans) {
    dealIds.add(row.deal_id);
    const dealLocks = await getDealApprovalLocks(row.deal_id);
    const existingEntries = db
      .prepare(
        `SELECT id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status
         FROM commission_entries WHERE deal_id = ?`
      )
      .all(row.deal_id);

    const ceId = await processRevenueEvent(row.id, {
      dealLocks,
      existingEntries: existingEntries as any,
      bypassApprovalLock: true,
    });
    console.log(`  ${row.client_name}: rev ${row.id.slice(0, 8)}… -> CE ${ceId ?? '(failed)'}`);
  }

  for (const dealId of dealIds) {
    const relink = relinkCommissionEntriesForDeal(db, dealId);
    if (relink.linked) console.log(`  Relinked ${relink.linked} on deal ${dealId.slice(0, 8)}…`);
  }

  const remaining = db
    .prepare(
      `
    SELECT COUNT(*) c FROM revenue_events re
    JOIN deals d ON d.id = re.deal_id
    WHERE d.cancellation_date IS NULL AND re.commissionable = 1
      AND NOT EXISTS (
        SELECT 1 FROM commission_entries ce
        WHERE ce.revenue_event_id = re.id AND ce.status != 'cancelled'
      )
  `
    )
    .get() as { c: number };
  console.log(`Remaining orphans: ${remaining.c}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
