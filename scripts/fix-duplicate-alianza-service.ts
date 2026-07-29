/**
 * Remove duplicate 990 service on Alianza For progress and reprocess.
 * Run: USE_LOCAL_DB=true npx tsx scripts/fix-duplicate-alianza-service.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const DEAL_ID = '25452fca-cfd1-4f38-8cdd-70a8fc633a40';
/** Second 990 service added 15s after the first — duplicate */
const DUPLICATE_SERVICE_ID = '153d655c-d599-4b86-8879-b9fb911a51f1';

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
    SELECT ce.amount, ce.payable_date, COALESCE(ds.service_name, ds2.service_name) as service_name
    FROM commission_entries ce
    LEFT JOIN deal_services ds ON ce.service_id = ds.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds2 ON re.service_id = ds2.id
    WHERE ce.deal_id = ? ORDER BY ce.payable_date, service_name
  `
    )
    .all(DEAL_ID) as Array<{ service_name: string; payable_date: string; amount: number }>;

  console.log(`\nCommission entries after fix (${after.length}):`);
  for (const r of after) {
    console.log(`  ${r.service_name} | ${r.payable_date} | $${r.amount}`);
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
