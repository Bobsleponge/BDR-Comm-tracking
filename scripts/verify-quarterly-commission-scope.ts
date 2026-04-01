/**
 * Verify Quarterly Commission (Closed Deals) - Scope & Completeness
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/verify-quarterly-commission-scope.ts [bdr_id]
 *
 * Checks:
 * 1. All deals in scope (closed-won, not cancelled, close/proposal in current quarter)
 * 2. All services loaded (no missing join)
 * 3. Full value vs our calculated (renewal uplift) breakdown
 * 4. Optional: what if we included ALL closed deals (any quarter)?
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

  console.log('\n=== Quarterly Commission (Closed Deals) - Scope Verification ===\n');
  console.log(`Quarter: ${currentQuarter} (${quarterStartStr} to ${quarterEndStr})`);
  console.log(`Scope: Deals with close_date OR proposal_date in this quarter\n`);

  for (const targetBdrId of bdrIds) {
    const bdrName =
      (db.prepare('SELECT name FROM bdr_reps WHERE id = ?').get(targetBdrId) as { name?: string })
        ?.name ?? targetBdrId;
    console.log(`--- BDR: ${bdrName} ---\n`);

    // In-scope: closed-won, not cancelled, sign date in Q1
    const inScopeDeals = db
      .prepare(
        `
      SELECT d.id, d.deal_value, d.original_deal_value, d.is_renewal,
             COALESCE(d.close_date, d.proposal_date) as sign_date
      FROM deals d
      WHERE d.bdr_id = ? AND d.status = 'closed-won' AND d.cancellation_date IS NULL
        AND COALESCE(d.close_date, d.proposal_date) >= ?
        AND COALESCE(d.close_date, d.proposal_date) <= ?
      `
      )
      .all(targetBdrId, quarterStartStr, quarterEndStr) as any[];

    const dealIds = inScopeDeals.map((d) => d.id);
    const totalDealValue = inScopeDeals.reduce((s, d) => s + Number(d.deal_value ?? 0), 0);

    // Services for these deals
    const services =
      dealIds.length > 0
        ? (db
            .prepare(
              `SELECT deal_id, id, service_name, commissionable_value, commission_rate, is_renewal, original_service_value
               FROM deal_services WHERE deal_id IN (${dealIds.map(() => '?').join(',')})`
            )
            .all(...dealIds) as any[])
        : [];

    const serviceCount = services.length;
    const totalCommissionable = services.reduce(
      (s, svc) => s + Number(svc.commissionable_value ?? 0),
      0
    );

    // Replicate stats API calc
    const dealTotals = new Map<string, number>();
    for (const svc of services) {
      const cv = svc.commissionable_value ?? 0;
      dealTotals.set(svc.deal_id, (dealTotals.get(svc.deal_id) ?? 0) + cv);
    }

    let calcCommission = 0;
    let calcBaseAmount = 0;

    for (const deal of inScopeDeals) {
      const dealServices = services.filter((s) => s.deal_id === deal.id);
      const origDeal = deal.original_deal_value ?? 0;
      const dealVal = deal.deal_value ?? 0;
      const totalDealComm = dealTotals.get(deal.id) ?? 0;

      if (dealServices.length === 0) {
        const isRenewal = deal.is_renewal === 1 && origDeal > 0;
        const baseAmount = isRenewal
          ? Math.max(0, dealVal - origDeal)
          : dealVal;
        calcBaseAmount += baseAmount;
        calcCommission += baseAmount * defaultRate;
        continue;
      }

      for (const svc of dealServices) {
        const isRenewal =
          svc.is_renewal === 1 || (deal.is_renewal === 1 && origDeal > 0);
        const rate = svc.commission_rate ?? defaultRate;
        const commVal = Number(svc.commissionable_value ?? 0);
        const origSvc = Number(svc.original_service_value ?? 0);

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
          baseAmount = isRenewal
            ? origDeal > 0
              ? Math.max(0, dealVal - origDeal)
              : 0
            : dealVal;
        }
        calcBaseAmount += baseAmount;
        calcCommission += baseAmount * rate;
      }
    }

    const fullCommissionAt2p5 = totalCommissionable * defaultRate;
    const renewalDeduction = totalCommissionable - calcBaseAmount;

    console.log('SCOPE:');
    console.log(`  Deals in Q1 2026:           ${inScopeDeals.length}`);
    console.log(`  Services (all loaded):      ${serviceCount}`);
    console.log(`  Deals with 0 services:      ${inScopeDeals.filter((d) => !services.some((s) => s.deal_id === d.id)).length}`);
    console.log('');
    console.log('AMOUNTS:');
    console.log(`  Sum deal_value:             $${totalDealValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`  Sum commissionable_value:   $${totalCommissionable.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log('');
    console.log('COMMISSION CALC:');
    console.log(`  If full 2.5% (no renewals): $${fullCommissionAt2p5.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`  Renewal uplift deduction:   $${renewalDeduction.toLocaleString('en-US', { minimumFractionDigits: 2 })} (excluded from commission)`);
    console.log(`  Base amount (2.5% applied): $${calcBaseAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`  Our calculated commission: $${calcCommission.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log('');

    // What if ALL closed deals (any quarter)?
    const allClosedDeals = db
      .prepare(
        `
      SELECT d.id, d.deal_value, d.original_deal_value, d.is_renewal
      FROM deals d
      WHERE d.bdr_id = ? AND d.status = 'closed-won' AND d.cancellation_date IS NULL
      `
      )
      .all(targetBdrId) as any[];

    const allDealIds = allClosedDeals.map((d) => d.id);
    const allServices =
      allDealIds.length > 0
        ? (db
            .prepare(
              `SELECT deal_id, commissionable_value, commission_rate, is_renewal, original_service_value
               FROM deal_services WHERE deal_id IN (${allDealIds.map(() => '?').join(',')})`
            )
            .all(...allDealIds) as any[])
        : [];

    const allDealTotals = new Map<string, number>();
    for (const svc of allServices) {
      const cv = svc.commissionable_value ?? 0;
      allDealTotals.set(svc.deal_id, (allDealTotals.get(svc.deal_id) ?? 0) + cv);
    }

    let allCalcCommission = 0;
    for (const deal of allClosedDeals) {
      const dealSvcs = allServices.filter((s) => s.deal_id === deal.id);
      const origDeal = deal.original_deal_value ?? 0;
      const dealVal = deal.deal_value ?? 0;
      const totalDealComm = allDealTotals.get(deal.id) ?? 0;

      if (dealSvcs.length === 0) {
        const baseAmount =
          deal.is_renewal === 1 && origDeal > 0
            ? Math.max(0, dealVal - origDeal)
            : dealVal;
        allCalcCommission += baseAmount * defaultRate;
        continue;
      }

      for (const svc of dealSvcs) {
        const isRenewal = svc.is_renewal === 1 || (deal.is_renewal === 1 && origDeal > 0);
        const rate = svc.commission_rate ?? defaultRate;
        const commVal = Number(svc.commissionable_value ?? 0);
        const origSvc = Number(svc.original_service_value ?? 0);
        let baseAmount: number;
        if (commVal > 0) {
          if (isRenewal) {
            const origForSvc =
              origSvc > 0
                ? origSvc
                : origDeal > 0 && totalDealComm > 0
                  ? origDeal * (commVal / totalDealComm)
                  : 0;
            baseAmount = Math.max(0, commVal - origForSvc);
          } else {
            baseAmount = commVal;
          }
        } else {
          baseAmount =
            isRenewal && origDeal > 0 ? Math.max(0, dealVal - origDeal) : dealVal;
        }
        allCalcCommission += baseAmount * rate;
      }
    }

    console.log('COMPARISON (for context):');
    console.log(`  Q1 only (current metric):   $${calcCommission.toFixed(2)} (${inScopeDeals.length} deals)`);
    console.log(`  ALL closed deals ever:      $${allCalcCommission.toFixed(2)} (${allClosedDeals.length} deals)`);
    console.log('');
  }
}

main();
