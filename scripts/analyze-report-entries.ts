/**
 * Analyze why entries appear in current report - when were they due? why not in prior reports?
 * Run: USE_LOCAL_DB=true npx tsx scripts/analyze-report-entries.ts
 */

import { getLocalDB } from '../lib/db/local-db';

const today = new Date().toISOString().split('T')[0];

function main() {
  const db = getLocalDB();

  // Today's draft batch
  const batch = db.prepare(`
    SELECT id, bdr_id, run_date, status
    FROM commission_batches
    WHERE run_date = ? AND status = 'draft'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(today) as { id: string; bdr_id: string; run_date: string; status: string } | undefined;

  if (!batch) {
    console.log('No draft batch for today.');
    return;
  }

  const items = db.prepare(`
    SELECT ce.id, ce.deal_id, ce.payable_date, ce.accrual_date, ce.month, ce.amount, ce.created_at,
           ce.revenue_event_id, re.created_at as rev_created,
           d.client_name, d.close_date
    FROM commission_batch_items cbi
    JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    JOIN deals d ON ce.deal_id = d.id
    WHERE cbi.batch_id = ?
  `).all(batch.id) as any[];

  // Group by effective month (when commission was due)
  const byMonth: Record<string, number> = {};
  const byCloseMonth: Record<string, number> = {};
  const createdAges: number[] = [];
  const revCreatedAges: number[] = [];

  for (const i of items) {
    const effMonth = i.payable_date?.slice(0, 7) || i.accrual_date?.slice(0, 7) || i.month || 'unknown';
    byMonth[effMonth] = (byMonth[effMonth] || 0) + 1;

    const closeMonth = i.close_date?.slice(0, 7) || 'unknown';
    byCloseMonth[closeMonth] = (byCloseMonth[closeMonth] || 0) + 1;

    if (i.created_at) {
      const ageDays = Math.floor((Date.now() - new Date(i.created_at).getTime()) / (24 * 60 * 60 * 1000));
      createdAges.push(ageDays);
    }
    if (i.rev_created) {
      const ageDays = Math.floor((Date.now() - new Date(i.rev_created).getTime()) / (24 * 60 * 60 * 1000));
      revCreatedAges.push(ageDays);
    }
  }

  console.log('\n=== Current report analysis ===\n');
  console.log(`Total entries: ${items.length}\n`);

  console.log('By payable/accrual month (when commission was due):');
  const sortedMonths = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [m, c] of sortedMonths) {
    console.log(`  ${m}: ${c}`);
  }

  console.log('\nBy deal close month:');
  const sortedClose = Object.entries(byCloseMonth).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [m, c] of sortedClose) {
    console.log(`  ${m}: ${c}`);
  }

  if (createdAges.length) {
    const avgAge = Math.round(createdAges.reduce((a, b) => a + b, 0) / createdAges.length);
    const minAge = Math.min(...createdAges);
    const maxAge = Math.max(...createdAges);
    const recent = createdAges.filter(d => d <= 7).length;
    console.log(`\nCommission entry creation (days ago): avg=${avgAge}, min=${minAge}, max=${maxAge}`);
    console.log(`  Created in last 7 days: ${recent} (${Math.round(100 * recent / createdAges.length)}%)`);
  }
  if (revCreatedAges.length) {
    const avgRev = Math.round(revCreatedAges.reduce((a, b) => a + b, 0) / revCreatedAges.length);
    const recentRev = revCreatedAges.filter(d => d <= 7).length;
    console.log(`\nRevenue event creation (days ago): avg=${avgRev}, in last 7 days: ${recentRev}`);
  }

  // Previous approved reports
  const priorBatches = db.prepare(`
    SELECT id, run_date, status
    FROM commission_batches
    WHERE bdr_id = ? AND status IN ('approved', 'paid')
    ORDER BY run_date DESC
    LIMIT 10
  `).all(batch.bdr_id) as Array<{ id: string; run_date: string; status: string }>;

  console.log('\nPrevious approved/paid reports:');
  for (const b of priorBatches) {
    const count = db.prepare(`SELECT COUNT(*) as c FROM commission_batch_items WHERE batch_id = ?`).get(b.id) as { c: number };
    console.log(`  ${b.run_date}: ${count?.c ?? 0} entries (${b.status})`);
  }

  const youngestPriorRun = priorBatches[0]?.run_date;
  if (youngestPriorRun) {
    const createdAfterLastReport = items.filter(i => {
      const cr = i.created_at ? i.created_at.slice(0, 10) : null;
      return cr && cr > youngestPriorRun;
    });
    console.log(`\n*** Entries created AFTER last approved report (${youngestPriorRun}): ${createdAfterLastReport.length} of ${items.length} ***`);
  }

  console.log('\nConclusion: These entries did not exist when prior reports were run.');
  console.log('They were created recently (reprocessing, new deals, or revenue events added/updated).\n');
}

main();
