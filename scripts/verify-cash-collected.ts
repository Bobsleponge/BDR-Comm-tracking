/**
 * VERIFICATION SCRIPT: Cash Collected Calculation
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/verify-cash-collected.ts [bdr_id]
 *
 * This script verifies the dashboard cash collected logic by:
 * 1. Running the exact same queries the dashboard uses
 * 2. Showing raw revenue_events that match the filters
 * 3. Comparing against a "ground truth" (sum of all matching events)
 * 4. Reporting any discrepancies
 */

import { getLocalDB } from '../lib/db/local-db';
import { format } from 'date-fns';
import { getQuarterFromDate, parseQuarter } from '../lib/commission/calculator';

const bdrId = process.argv[2] || 'test-bdr-id';

function main() {
  const db = getLocalDB();

  // Get all BDRs if no specific one
  const bdrIds = bdrId
    ? [bdrId]
    : (db.prepare('SELECT id FROM bdr_reps').all() as { id: string }[]).map((r) => r.id);

  if (bdrIds.length === 0) {
    console.error('No BDRs found. Specify bdr_id or ensure bdr_reps has data.');
    process.exit(1);
  }

  const today = new Date();
  const currentQuarter = getQuarterFromDate(today);
  const todayStr = format(today, 'yyyy-MM-dd');
  const { start: quarterStart, end: quarterEnd } = parseQuarter(currentQuarter);
  const quarterStartStr = format(quarterStart, 'yyyy-MM-dd');
  const quarterEndStr = format(quarterEnd, 'yyyy-MM-dd');
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const yearEnd = new Date(today.getFullYear(), 11, 31);
  const yearStartStr = format(yearStart, 'yyyy-MM-dd');
  const yearEndStr = format(yearEnd, 'yyyy-MM-dd');

  console.log('='.repeat(70));
  console.log('CASH COLLECTED VERIFICATION REPORT');
  console.log('='.repeat(70));
  console.log(`Date: ${todayStr}`);
  console.log(`Quarter: ${currentQuarter} (${quarterStartStr} to ${quarterEndStr})`);
  console.log(`Year: ${yearStartStr} to ${yearEndStr}`);
  console.log('');

  for (const targetBdrId of bdrIds) {
    console.log('-'.repeat(70));
    console.log(`BDR: ${targetBdrId}`);
    console.log('-'.repeat(70));

    // 1. DASHBOARD QUERY (exact copy from route.ts) - excludes cancelled-deal revenue
    const dashboardQuarterly = db
      .prepare(
        `SELECT COALESCE(SUM(re.amount_collected), 0) as total
       FROM revenue_events re
       INNER JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ? AND re.commissionable = 1
       AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)`
      )
      .get(targetBdrId, quarterStartStr, quarterEndStr, todayStr) as { total: number };

    const dashboardAnnual = db
      .prepare(
        `SELECT COALESCE(SUM(re.amount_collected), 0) as total
       FROM revenue_events re
       INNER JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ? AND re.commissionable = 1
       AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)`
      )
      .get(targetBdrId, yearStartStr, yearEndStr, todayStr) as { total: number };

    const quarterlyDashboard = Number(dashboardQuarterly?.total || 0);
    const annualDashboard = Number(dashboardAnnual?.total || 0);

    // 2. GROUND TRUTH - manually sum events that match the filters (incl. cancellation check)
    const quarterlyEvents = db
      .prepare(
        `SELECT re.id, re.collection_date, re.amount_collected, re.billing_type, re.commissionable, d.cancellation_date
       FROM revenue_events re
       LEFT JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ?
       ORDER BY re.collection_date`
      )
      .all(targetBdrId) as Array<{
      id: string;
      collection_date: string;
      amount_collected: number;
      billing_type: string;
      commissionable: number;
      cancellation_date: string | null;
    }>;

    let quarterlyManual = 0;
    let annualManual = 0;
    const quarterlyMatched: typeof quarterlyEvents = [];
    const quarterlyExcluded: typeof quarterlyEvents = [];

    for (const e of quarterlyEvents) {
      const dateStr = e.collection_date.split('T')[0];
      const inQuarter = dateStr >= quarterStartStr && dateStr <= quarterEndStr && dateStr <= todayStr;
      const inYear = dateStr >= yearStartStr && dateStr <= yearEndStr && dateStr <= todayStr;
      const commissionable = e.commissionable === 1 || e.commissionable === true;
      const notCancelled = !e.cancellation_date || dateStr < e.cancellation_date;

      if (commissionable && notCancelled && inQuarter) {
        quarterlyManual += Number(e.amount_collected || 0);
        quarterlyMatched.push(e);
      } else if (inQuarter) {
        quarterlyExcluded.push(e);
      }

      if (commissionable && notCancelled && inYear) {
        annualManual += Number(e.amount_collected || 0);
      }
    }

    // 3. RAW TOTALS (no date cap, no commissionable filter - for reference)
    const rawQuarterlyAll = db
      .prepare(
        `SELECT COALESCE(SUM(re.amount_collected), 0) as total, COUNT(*) as cnt
       FROM revenue_events re
       INNER JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ?
       AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)`
      )
      .get(targetBdrId, quarterStartStr, quarterEndStr) as { total: number; cnt: number };

    const rawQuarterlyCapped = db
      .prepare(
        `SELECT COALESCE(SUM(re.amount_collected), 0) as total, COUNT(*) as cnt
       FROM revenue_events re
       INNER JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ?
       AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)`
      )
      .get(targetBdrId, quarterStartStr, quarterEndStr, todayStr) as { total: number; cnt: number };

    const rawQuarterlyCommissionable = db
      .prepare(
        `SELECT COALESCE(SUM(re.amount_collected), 0) as total, COUNT(*) as cnt
       FROM revenue_events re
       INNER JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ? AND re.commissionable = 1
       AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)`
      )
      .get(targetBdrId, quarterStartStr, quarterEndStr, todayStr) as { total: number; cnt: number };

    // 4. REPORT
    console.log('');
    console.log('QUARTERLY CASH COLLECTED');
    console.log('  Dashboard query result:     $' + quarterlyDashboard.toLocaleString('en-US', { minimumFractionDigits: 2 }));
    console.log('  Manual sum (same logic):   $' + quarterlyManual.toLocaleString('en-US', { minimumFractionDigits: 2 }));
    console.log('  Match: ' + (Math.abs(quarterlyDashboard - quarterlyManual) < 0.01 ? 'YES' : 'NO - DISCREPANCY'));

    console.log('');
    console.log('  Breakdown (what the query filters):');
    console.log('    - collection_date >= ' + quarterStartStr + ' (quarter start)');
    console.log('    - collection_date <= ' + quarterEndStr + ' (quarter end)');
    console.log('    - collection_date <= ' + todayStr + ' (cap at today)');
    console.log('    - commissionable = 1');
    console.log('    - exclude: deal cancelled before collection (collection_date >= cancellation_date)');
    console.log('    - bdr_id = ' + targetBdrId);

    console.log('');
    console.log('  Raw reference (no commissionable filter):');
    console.log('    Quarter range only (no today cap): $' + Number(rawQuarterlyAll?.total || 0).toLocaleString() + ' (' + rawQuarterlyAll?.cnt + ' events)');
    console.log('    With today cap:                    $' + Number(rawQuarterlyCapped?.total || 0).toLocaleString() + ' (' + rawQuarterlyCapped?.cnt + ' events)');
    console.log('    + commissionable=1 (dashboard):     $' + Number(rawQuarterlyCommissionable?.total || 0).toLocaleString() + ' (' + rawQuarterlyCommissionable?.cnt + ' events)');

    if (quarterlyExcluded.length > 0) {
      console.log('');
      console.log('  Excluded from quarterly (commissionable=0): ' + quarterlyExcluded.length + ' events');
      quarterlyExcluded.slice(0, 5).forEach((e) => {
        console.log('    - ' + e.collection_date + ' $' + e.amount_collected + ' (' + e.billing_type + ')');
      });
      if (quarterlyExcluded.length > 5) console.log('    ... and ' + (quarterlyExcluded.length - 5) + ' more');
    }

    console.log('');
    console.log('ANNUAL (YTD) CASH COLLECTED');
    console.log('  Dashboard query result:     $' + annualDashboard.toLocaleString('en-US', { minimumFractionDigits: 2 }));
    console.log('  Manual sum (same logic):     $' + annualManual.toLocaleString('en-US', { minimumFractionDigits: 2 }));
    console.log('  Match: ' + (Math.abs(annualDashboard - annualManual) < 0.01 ? 'YES' : 'NO - DISCREPANCY'));

    console.log('');
  }

  console.log('='.repeat(70));
  console.log('VERIFICATION COMPLETE');
  console.log('');
  console.log('If Dashboard and Manual sum match: the calculation is correct.');
  console.log('If they differ: there may be a bug in the query or data type handling.');
  console.log('');
  console.log('Key filters that reduce the total:');
  console.log('  1. collection_date <= today  (excludes future-dated revenue)');
  console.log('  2. commissionable = 1         (excludes non-commissionable revenue)');
  console.log('  3. Cancelled deals            (excludes revenue where collection_date >= deal.cancellation_date)');
  console.log('  4. Date range (quarter/year)  (only includes events in period)');
  console.log('='.repeat(70));
}

main();
