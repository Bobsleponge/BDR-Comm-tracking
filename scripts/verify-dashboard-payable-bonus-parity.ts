/**
 * Sanity-check payable-date quarterly bonus totals (local SQLite).
 *
 * For each calendar quarter: compares aggregate from `fetchPayableBonusRowsLocal`
 * to 2.5% × sum of attributed revenue (must match). Optionally pass BDR id.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/verify-dashboard-payable-bonus-parity.ts [bdr_id]
 */
import { format } from 'date-fns';
import { getLocalDB } from '../lib/db/local-db';
import { fetchPayableBonusRowsLocal } from '../lib/dashboard/quarterly-bonus-export';

function main() {
  const db = getLocalDB();
  const argBdr = process.argv[2];
  const bdrId =
    argBdr ||
    (db.prepare('SELECT DISTINCT bdr_id FROM commission_entries LIMIT 1').get() as { bdr_id: string } | undefined)
      ?.bdr_id ||
    (db.prepare('SELECT id FROM bdr_reps LIMIT 1').get() as { id: string } | undefined)?.id;
  if (!bdrId) {
    console.error('No BDR id (pass argv[1] or seed bdr_reps).');
    process.exit(1);
  }

  const year = new Date().getFullYear();
  const quarters: Array<{ key: string; start: string; end: string }> = [
    { key: `${year}-Q1`, start: format(new Date(year, 0, 1), 'yyyy-MM-dd'), end: format(new Date(year, 2, 31), 'yyyy-MM-dd') },
    { key: `${year}-Q2`, start: format(new Date(year, 3, 1), 'yyyy-MM-dd'), end: format(new Date(year, 5, 30), 'yyyy-MM-dd') },
    { key: `${year}-Q3`, start: format(new Date(year, 6, 1), 'yyyy-MM-dd'), end: format(new Date(year, 8, 30), 'yyyy-MM-dd') },
    { key: `${year}-Q4`, start: format(new Date(year, 9, 1), 'yyyy-MM-dd'), end: format(new Date(year, 11, 31), 'yyyy-MM-dd') },
  ];

  const today = format(new Date(), 'yyyy-MM-dd');
  let ok = true;
  for (const q of quarters) {
    const full = fetchPayableBonusRowsLocal(db, bdrId, q.start, q.end);
    const fromRows = full.rows.reduce((s, r) => s + parseFloat(r.attributed_revenue || '0'), 0);
    const bonusFromRows = Number((fromRows * 0.025).toFixed(2));
    const matchBonus = Math.abs(full.totalBonus - bonusFromRows) < 0.02;
    const matchRev = Math.abs(full.totalAttributedRevenue - fromRows) < 0.02;
    if (!matchBonus || !matchRev) {
      ok = false;
      console.error(`FAIL ${q.key}: totalBonus=${full.totalBonus} vs rows*2.5%=${bonusFromRows}, attributed=${full.totalAttributedRevenue} vs sum rows=${fromRows}`);
    } else {
      console.log(`OK ${q.key}: bonus=${full.totalBonus}, commission=${full.totalCommission}, revenue_attr=${full.totalAttributedRevenue}`);
    }
    let thru = 0;
    for (const r of full.rows) {
      if (r.payable_date <= today) thru += parseFloat(r.attributed_revenue || '0');
    }
    console.log(`   payable_through_today_bonus ≈ ${(thru * 0.025).toFixed(2)} (as of ${today})`);
  }
  process.exit(ok ? 0 : 1);
}

main();
