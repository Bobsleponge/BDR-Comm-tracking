/**
 * Run: USE_LOCAL_DB=true npx tsx scripts/commission-status-summary.ts
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
  const { isEntryBillable, isEntryApprovalSettled } = await import('../lib/commission/approval-lock');

  const db = getLocalDB();
  const entries = db.prepare(
    'SELECT id, deal_id, amount, payable_date, accrual_date, month, status FROM commission_entries'
  ).all() as any[];
  const locksCache = new Map<string, Awaited<ReturnType<typeof getDealApprovalLocks>>>();
  let billable = 0;
  let approved = 0;
  let paid = 0;
  let accrued = 0;

  for (const e of entries) {
    if (!locksCache.has(e.deal_id)) {
      locksCache.set(e.deal_id, await getDealApprovalLocks(e.deal_id));
    }
    const locks = locksCache.get(e.deal_id)!;
    const peers = entries.filter((x) => x.deal_id === e.deal_id);
    if (isEntryBillable(e, locks, peers)) billable++;
    if (isEntryApprovalSettled(e, locks, peers)) approved++;
    if (e.status === 'paid') paid++;
    if (e.status === 'accrued') accrued++;
  }

  console.log({ total: entries.length, billable, approved, paid, accrued });
  const stillMissing = db.prepare(`
    SELECT COUNT(*) as c FROM revenue_events re
    WHERE re.commissionable = 1
      AND NOT EXISTS (SELECT 1 FROM commission_entries ce WHERE ce.revenue_event_id = re.id)
  `).get() as { c: number };
  console.log('Revenue events still missing entries:', stillMissing.c);
}

main().catch(console.error);
