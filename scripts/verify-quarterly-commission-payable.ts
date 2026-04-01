/**
 * Verify Quarterly Commission (Closed Deals) - payable_date scope, total value basis
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/verify-quarterly-commission-payable.ts [bdr_id]
 *
 * Replicates the dashboard stats API logic and validates:
 * 1. Deals in scope (any commission_entry with payable_date in Q1)
 * 2. Commission from deal_services: new = full value, renewal = uplift only
 * 3. Cross-check: entries with null payable_date but accrual_date in Q1 (potential gap)
 */

import { getLocalDB } from '../lib/db/local-db';
import { format } from 'date-fns';
import { getQuarterFromDate, parseQuarter } from '../lib/commission/calculator';

const bdrId = process.argv[2] || null;
const defaultRate = 0.025;

function main() {
  const db = getLocalDB();

  const bdrIds: string[] = bdrId
    ? [bdrId]
    : (db.prepare('SELECT id FROM bdr_reps').all() as { id: string }[]).map((r) => r.id);

  const today = new Date();
  const currentQuarter = getQuarterFromDate(today);
  const { start: quarterStart, end: quarterEnd } = parseQuarter(currentQuarter);
  const quarterStartStr = format(quarterStart, 'yyyy-MM-dd');
  const quarterEndStr = format(quarterEnd, 'yyyy-MM-dd');

  console.log('\n=== Quarterly Commission (Payable in Q1) - Verification ===\n');
  console.log(`Quarter: ${currentQuarter} (${quarterStartStr} to ${quarterEndStr})`);
  console.log(`Scope: Deals with any commission_entry where payable_date in Q1\n`);

  for (const targetBdrId of bdrIds) {
    const bdrName =
      (db.prepare('SELECT name FROM bdr_reps WHERE id = ?').get(targetBdrId) as { name?: string })?.name ??
      targetBdrId;
    console.log(`--- BDR: ${bdrName} (${targetBdrId}) ---\n`);

    // 1. Deals with payable_date in Q1 (matches dashboard exactly)
    const dealIdsWithPayableInQ1 = db
      .prepare(
        `
        SELECT DISTINCT ce.deal_id
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
          AND ce.payable_date >= ? AND ce.payable_date <= ?
          AND d.cancellation_date IS NULL
      `
      )
      .all(targetBdrId, quarterStartStr, quarterEndStr) as { deal_id: string }[];
    const q1DealIds = [...new Set(dealIdsWithPayableInQ1.map((r) => r.deal_id))];

    // Check for entries with null payable_date but accrual_date in Q1 (potential gap)
    const nullPayableInQ1 = db
      .prepare(
        `
        SELECT ce.id, ce.deal_id, ce.payable_date, ce.accrual_date, ce.month, ce.amount
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
          AND ce.payable_date IS NULL
          AND (ce.accrual_date >= ? AND ce.accrual_date <= ?)
          AND d.cancellation_date IS NULL
      `
      )
      .all(targetBdrId, quarterStartStr, quarterEndStr) as Array<{
      id: string;
      deal_id: string;
      payable_date: string | null;
      accrual_date: string | null;
      month: string | null;
      amount: number;
    }>;

    if (nullPayableInQ1.length > 0) {
      console.log(`  ⚠️  ${nullPayableInQ1.length} commission entries have null payable_date but accrual_date in Q1`);
      console.log(`     (These deals would be EXCLUDED from current dashboard calc)\n`);
    }

    if (q1DealIds.length === 0) {
      console.log('  No deals with payable_date in Q1.\n');
      continue;
    }

    // 2. Get deal_services for these deals
    const placeholders = q1DealIds.map(() => '?').join(',');
    const services = db
      .prepare(
        `
        SELECT ds.deal_id, ds.service_name, ds.commissionable_value, ds.commission_rate, ds.original_service_value, ds.is_renewal,
               d.original_deal_value, d.deal_value, d.is_renewal as deal_is_renewal, c.name as client_name
        FROM deal_services ds
        INNER JOIN deals d ON ds.deal_id = d.id
        LEFT JOIN clients c ON d.client_id = c.id
        WHERE ds.deal_id IN (${placeholders})
        ORDER BY ds.deal_id, ds.id
      `
      )
      .all(...q1DealIds) as Array<{
      deal_id: string;
      service_name: string;
      commissionable_value: number | null;
      commission_rate: number | null;
      original_service_value: number | null;
      is_renewal: number | null;
      original_deal_value: number | null;
      deal_value: number | null;
      deal_is_renewal: number | null;
      client_name: string | null;
    }>;

    const dealTotals = new Map<string, number>();
    for (const svc of services) {
      const cv = svc.commissionable_value ?? 0;
      dealTotals.set(svc.deal_id, (dealTotals.get(svc.deal_id) ?? 0) + cv);
    }

    let totalCommission = 0;
    let totalBaseAmount = 0;
    const dealBreakdown: Array<{
      dealId: string;
      clientName: string;
      services: Array<{ name: string; baseAmount: number; rate: number; commission: number; isRenewal: boolean }>;
      dealTotal: number;
    }> = [];
    let currentDeal: {
      dealId: string;
      clientName: string;
      services: Array<{ name: string; baseAmount: number; rate: number; commission: number; isRenewal: boolean }>;
    } | null = null;

    for (const svc of services) {
      const isRenewal =
        svc.is_renewal === 1 || (svc.deal_is_renewal === 1 && (svc.original_deal_value ?? 0) > 0);
      const rate = svc.commission_rate ?? defaultRate;
      const commVal = Number(svc.commissionable_value ?? 0);
      const origSvc = Number(svc.original_service_value ?? 0);
      const origDeal = svc.original_deal_value ?? 0;
      const dealVal = svc.deal_value ?? 0;
      const totalDealComm = dealTotals.get(svc.deal_id) ?? 0;

      let baseAmount: number;
      if (commVal > 0) {
        if (isRenewal) {
          const origForSvc =
            origSvc > 0 ? origSvc : origDeal > 0 && totalDealComm > 0 ? (origDeal * commVal) / totalDealComm : 0;
          baseAmount = Math.max(0, commVal - origForSvc);
        } else {
          baseAmount = commVal;
        }
      } else {
        baseAmount = isRenewal ? (origDeal > 0 ? Math.max(0, dealVal - origDeal) : 0) : dealVal;
      }

      const commission = baseAmount * rate;
      totalCommission += commission;
      totalBaseAmount += baseAmount;

      const clientName = svc.client_name ?? '(unknown)';
      const serviceName = svc.service_name ?? '(deal-level)';

      if (!currentDeal || currentDeal.dealId !== svc.deal_id) {
        currentDeal = { dealId: svc.deal_id, clientName, services: [] };
        dealBreakdown.push({ ...currentDeal, dealTotal: 0 });
      }
      currentDeal.services.push({
        name: serviceName,
        baseAmount,
        rate,
        commission,
        isRenewal,
      });
      const last = dealBreakdown[dealBreakdown.length - 1];
      last.dealTotal = (last.dealTotal || 0) + commission;
    }

    // Deals without services
    const dealsWithServices = new Set(services.map((s) => s.deal_id));
    for (const dealId of q1DealIds) {
      if (dealsWithServices.has(dealId)) continue;
      const dealFull = db
        .prepare(
          'SELECT d.deal_value, d.original_deal_value, d.is_renewal, c.name as client_name FROM deals d LEFT JOIN clients c ON d.client_id = c.id WHERE d.id = ?'
        )
        .get(dealId) as { deal_value: number; original_deal_value: number | null; is_renewal: number; client_name: string } | undefined;
      const deal = dealFull;
      if (!deal) continue;
      const origDeal = deal.original_deal_value ?? 0;
      const dealVal = deal.deal_value ?? 0;
      const isRenewal = deal.is_renewal === 1 && origDeal > 0;
      const baseAmount = isRenewal ? Math.max(0, dealVal - origDeal) : dealVal;
      const commission = baseAmount * defaultRate;
      totalCommission += commission;
      totalBaseAmount += baseAmount;
      dealBreakdown.push({
        dealId,
        clientName: deal?.client_name ?? '(unknown)',
        services: [{ name: '(no services)', baseAmount, rate: defaultRate, commission, isRenewal }],
        dealTotal: commission,
      });
    }

    // Print breakdown
    for (const d of dealBreakdown) {
      console.log(`  Deal ${d.dealId.slice(0, 8)}... - ${d.clientName}:`);
      for (const s of d.services) {
        const type = s.isRenewal ? '(renewal uplift)' : '(new)';
        console.log(
          `    ${s.name} ${type}: base=$${s.baseAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} × ${(s.rate * 100).toFixed(1)}% = $${s.commission.toFixed(2)}`
        );
      }
      console.log(`    → Subtotal: $${d.dealTotal.toFixed(2)}\n`);
    }

    console.log('  TOTALS:');
    console.log(`    Base amount (commissionable): $${totalBaseAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`    Commission (2.5%):           $${Number(totalCommission.toFixed(2)).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`    Deals in scope:              ${q1DealIds.length}`);
    console.log('');

    // Cross-check: sum of commission_entries.amount for same deals (cash-based - should differ)
    const ceSum = db
      .prepare(
        `
        SELECT COALESCE(SUM(ce.amount), 0) as total
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
          AND ce.payable_date >= ? AND ce.payable_date <= ?
          AND d.cancellation_date IS NULL
      `
      )
      .get(targetBdrId, quarterStartStr, quarterEndStr) as { total: number };
    console.log('  CROSS-CHECK (cash-based commission entries sum):');
    console.log(`    Sum ce.amount (payable in Q1): $${Number(ceSum?.total ?? 0).toFixed(2)}`);
    console.log(`    (This is 2.5% of cash collected, not total value - expected to differ)\n`);
  }
}

main();
