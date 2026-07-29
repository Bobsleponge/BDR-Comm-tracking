/**
 * Remove duplicate 1040 service on Filomena Jane Rose and reprocess.
 * Run: USE_LOCAL_DB=true npx tsx scripts/fix-duplicate-filomena-service.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const DEAL_ID = '4aa6897e-d0d5-4f63-84f5-1e4c89e513c9';
/** Second 1040 service added ~2 min after the first — duplicate */
const DUPLICATE_SERVICE_ID = 'cceab688-00b8-48e7-bfe9-813ca819beea';

async function main() {
  const { getLocalDB } = await import('../lib/db/local-db');
  const { safeReprocessDeal } = await import('../lib/commission/safe-reprocess');
  const db = getLocalDB();

  const dup = db.prepare('SELECT * FROM deal_services WHERE id = ?').get(DUPLICATE_SERVICE_ID) as
    | { service_name: string }
    | undefined;
  if (!dup) {
    console.log('Duplicate service already removed.');
    return;
  }

  console.log(`Removing duplicate service: ${dup.service_name} (${DUPLICATE_SERVICE_ID})`);

  const dupEntryIds = db
    .prepare(
      `
    SELECT ce.id FROM commission_entries ce
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    WHERE ce.deal_id = ? AND (ce.service_id = ? OR re.service_id = ?)
  `
    )
    .all(DEAL_ID, DUPLICATE_SERVICE_ID, DUPLICATE_SERVICE_ID) as Array<{ id: string }>;

  for (const { id } of dupEntryIds) {
    db.prepare('DELETE FROM commission_batch_items WHERE commission_entry_id = ?').run(id);
    db.prepare('DELETE FROM commission_entries WHERE id = ?').run(id);
  }

  db.prepare('DELETE FROM revenue_events WHERE deal_id = ? AND service_id = ?').run(DEAL_ID, DUPLICATE_SERVICE_ID);
  db.prepare('DELETE FROM deal_services WHERE id = ?').run(DUPLICATE_SERVICE_ID);

  const services = db
    .prepare('SELECT commissionable_value FROM deal_services WHERE deal_id = ?')
    .all(DEAL_ID) as Array<{ commissionable_value: number }>;
  const total = services.reduce((s, x) => s + Number(x.commissionable_value || 0), 0);
  db.prepare('UPDATE deals SET deal_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(total, DEAL_ID);

  const result = await safeReprocessDeal(DEAL_ID);
  console.log('Reprocess result:', result);

  const after = db
    .prepare(
      `
    SELECT ce.amount, ce.payable_date, ce.status, COALESCE(ds.service_name, ds2.service_name) as service_name
    FROM commission_entries ce
    LEFT JOIN deal_services ds ON ce.service_id = ds.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds2 ON re.service_id = ds2.id
    WHERE ce.deal_id = ? ORDER BY service_name, ce.payable_date
  `
    )
    .all(DEAL_ID) as Array<{ service_name: string; payable_date: string; amount: number; status: string }>;

  console.log(`\nCommission entries after fix (${after.length}):`);
  for (const r of after) {
    console.log(`  ${r.service_name} | ${r.payable_date} | $${r.amount} | ${r.status}`);
  }

  const dealValue = db.prepare('SELECT deal_value FROM deals WHERE id = ?').get(DEAL_ID) as {
    deal_value: number;
  };
  console.log(`\nDeal value: $${dealValue.deal_value}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
