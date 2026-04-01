/**
 * INVESTIGATE: Quarterly Commission (Closed Deals) for dashboard
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/investigate-quarterly-commission.ts [bdr_id]
 *
 * Replicates the dashboard stats API logic and reports:
 * - Per-deal breakdown of commission calculation
 * - Total Quarterly Commission (Closed Deals) for current quarter
 * - Comparison with commission preview total (if applicable)
 * - Any anomalies (deals without services, renewal proportion, etc.)
 */

import { getLocalDB } from '../lib/db/local-db';
import { format } from 'date-fns';
import { getQuarterFromDate, parseQuarter } from '../lib/commission/calculator';

const bdrId = process.argv[2] || null;
const defaultRate = 0.025;

interface DealRow {
  id: string;
  deal_value: number;
  original_deal_value: number | null;
  is_renewal: number;
  close_date: string | null;
  proposal_date: string | null;
  commissionable_value: number;
  commission_rate: number | null;
  original_service_value: number | null;
  svc_is_renewal: number;
  client_name?: string;
  service_name?: string;
}

function main() {
  const db = getLocalDB();

  // Get BDR IDs to check
  const bdrIds: string[] = bdrId ? [bdrId] : (db.prepare('SELECT id FROM bdr_reps').all() as { id: string }[]).map((r) => r.id);
  if (bdrIds.length === 0) {
    console.log('No BDR reps found.');
    return;
  }

  const today = new Date();
  const currentQuarter = getQuarterFromDate(today);
  const { start: quarterStart, end: quarterEnd } = parseQuarter(currentQuarter);
  const quarterStartStr = format(quarterStart, 'yyyy-MM-dd');
  const quarterEndStr = format(quarterEnd, 'yyyy-MM-dd');

  console.log(`\n=== Quarterly Commission (Closed Deals) Investigation ===`);
  console.log(`Quarter: ${currentQuarter} (${quarterStartStr} to ${quarterEndStr})`);
  console.log(`Today: ${format(today, 'yyyy-MM-dd')}\n`);

  for (const targetBdrId of bdrIds) {
    const bdrName = (db.prepare('SELECT name FROM bdr_reps WHERE id = ?').get(targetBdrId) as { name?: string })?.name ?? targetBdrId;
    console.log(`--- BDR: ${bdrName} (${targetBdrId}) ---\n`);

    // Same query as stats API (local)
    const rows = db
      .prepare(
        `
        SELECT d.id, d.deal_value, d.original_deal_value, d.is_renewal,
               ds.commissionable_value, ds.commission_rate, ds.original_service_value, ds.is_renewal as svc_is_renewal,
               COALESCE(d.close_date, d.proposal_date) as sign_date,
               c.name as client_name, ds.service_name
        FROM deals d
        LEFT JOIN deal_services ds ON ds.deal_id = d.id
        LEFT JOIN clients c ON d.client_id = c.id
        WHERE d.bdr_id = ? AND d.status = 'closed-won' AND d.cancellation_date IS NULL
        AND COALESCE(d.close_date, d.proposal_date) >= ? AND COALESCE(d.close_date, d.proposal_date) <= ?
        ORDER BY d.id, ds.id
      `
      )
      .all(targetBdrId, quarterStartStr, quarterEndStr) as DealRow[];

    if (rows.length === 0) {
      console.log('  No closed deals in this quarter.\n');
      continue;
    }

    // Group by deal for reporting
    const dealTotals = new Map<string, number>();
    for (const row of rows) {
      const cv = row.commissionable_value ?? 0;
      dealTotals.set(row.id, (dealTotals.get(row.id) ?? 0) + cv);
    }

    let totalCommission = 0;
    const dealBreakdown: Array<{ dealId: string; clientName: string; services: Array<{ name: string; baseAmount: number; rate: number; commission: number }>; dealTotal: number }> = [];
    let currentDeal: { dealId: string; clientName: string; services: Array<{ name: string; baseAmount: number; rate: number; commission: number }> } | null = null;

    for (const row of rows) {
      const origDeal = row.original_deal_value ?? 0;
      const isRenewal = row.svc_is_renewal === 1 || (row.is_renewal === 1 && origDeal > 0);
      const rate = row.commission_rate ?? defaultRate;
      const commVal = row.commissionable_value ?? 0;
      const dealVal = row.deal_value ?? 0;
      const origSvc = row.original_service_value ?? 0;
      const totalDealComm = dealTotals.get(row.id) ?? 0;

      let baseAmount: number;
      if (commVal > 0) {
        if (isRenewal) {
          let origForSvc: number;
          if (origSvc > 0) {
            origForSvc = origSvc;
          } else if (origDeal > 0 && totalDealComm > 0) {
            origForSvc = origDeal * (commVal / totalDealComm);
          } else {
            origForSvc = 0;
          }
          baseAmount = Math.max(0, commVal - origForSvc);
        } else {
          baseAmount = commVal;
        }
      } else {
        baseAmount = isRenewal ? (origDeal > 0 ? Math.max(0, dealVal - origDeal) : 0) : dealVal;
      }

      const commission = baseAmount * rate;
      totalCommission += commission;

      const clientName = row.client_name ?? '(unknown)';
      const serviceName = row.service_name ?? (commVal === 0 ? '(deal-level)' : '(service)');

      if (!currentDeal || currentDeal.dealId !== row.id) {
        currentDeal = { dealId: row.id, clientName, services: [] };
        dealBreakdown.push({ ...currentDeal, dealTotal: 0 });
      }
      currentDeal.services.push({
        name: serviceName,
        baseAmount,
        rate,
        commission,
      });
      const last = dealBreakdown[dealBreakdown.length - 1];
      last.dealTotal = (last.dealTotal || 0) + commission;
    }

    // Print breakdown
    for (const d of dealBreakdown) {
      console.log(`  Deal ${d.dealId} - ${d.clientName}:`);
      for (const s of d.services) {
        console.log(`    ${s.name}: base=$${s.baseAmount.toFixed(2)} × ${(s.rate * 100).toFixed(1)}% = $${s.commission.toFixed(2)}`);
      }
      console.log(`    → Subtotal: $${d.dealTotal.toFixed(2)}\n`);
    }

    const totalRounded = Number(totalCommission.toFixed(2));
    console.log(`  TOTAL Quarterly Commission (Closed Deals): $${totalRounded.toFixed(2)}\n`);

    // Cross-check: sum of deal_services.commission_amount per deal
    const expectedFromServices = db
      .prepare(
        `
        SELECT d.id, d.client_name, ds.service_name, ds.commission_amount, ds.commissionable_value, ds.commission_rate,
               ds.is_renewal, ds.original_service_value, d.original_deal_value, d.is_renewal as deal_is_renewal
        FROM deals d
        JOIN deal_services ds ON ds.deal_id = d.id
        WHERE d.bdr_id = ? AND d.status = 'closed-won' AND d.cancellation_date IS NULL
        AND COALESCE(d.close_date, d.proposal_date) >= ? AND COALESCE(d.close_date, d.proposal_date) <= ?
      `
      )
      .all(targetBdrId, quarterStartStr, quarterEndStr) as any[];

    const storedCommissionSum = expectedFromServices.reduce((s, r) => s + Number(r.commission_amount ?? 0), 0);
    console.log(`  Cross-check: Sum of deal_services.commission_amount for these deals: $${Number(storedCommissionSum.toFixed(2))}`);
    console.log(`  (deal_services.commission_amount = commission stored when service was saved)\n`);

    // Per-deal diff: our calc vs stored
    const ourByDeal = new Map<string, number>();
    for (const d of dealBreakdown) {
      ourByDeal.set(d.dealId, d.dealTotal);
    }
    const storedByDeal = new Map<string, number>();
    for (const r of expectedFromServices) {
      storedByDeal.set(r.id, (storedByDeal.get(r.id) ?? 0) + Number(r.commission_amount ?? 0));
    }

    const diffs: Array<{ dealId: string; clientName: string; ours: number; stored: number; diff: number }> = [];
    for (const [did, stored] of storedByDeal) {
      const ours = ourByDeal.get(did) ?? 0;
      const diff = stored - ours;
      if (Math.abs(diff) > 0.02) {
        const clientName = expectedFromServices.find((r) => r.id === did)?.client_name ?? '';
        diffs.push({ dealId: did, clientName, ours, stored, diff });
      }
    }

    // Also deals we have that have no stored (deal-level only)
    for (const did of ourByDeal.keys()) {
      if (!storedByDeal.has(did)) {
        const d = dealBreakdown.find((x) => x.dealId === did);
        diffs.push({
          dealId: did,
          clientName: d?.clientName ?? '',
          ours: ourByDeal.get(did) ?? 0,
          stored: 0,
          diff: ourByDeal.get(did) ?? 0,
        });
      }
    }

    if (diffs.length > 0) {
      console.log(`  DISCREPANCIES (|ours - stored| > $0.02):`);
      for (const d of diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))) {
        const sign = d.diff > 0 ? '(stored higher)' : '(ours higher)';
        console.log(`    ${d.clientName}: ours=$${d.ours.toFixed(2)} stored=$${d.stored.toFixed(2)} diff=$${d.diff.toFixed(2)} ${sign}`);
      }
      console.log('');
    }

    // Note: deal_services.commission_amount is the commission per service as calculated when the service was saved.
    // For renewals, it might be uplift-only. So storedCommissionSum could match our total if the stored amounts are correct.
  }
}

main();
