import { NextRequest } from 'next/server';
import { format } from 'date-fns';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { getQuarterFromDate, parseQuarter } from '@/lib/commission/calculator';
import {
  buildQuarterlyPayableProgressFromRows,
  fetchPayableBonusRowsLocal,
  fetchPayableBonusRowsSupabase,
} from '@/lib/dashboard/quarterly-bonus-export';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    // Determine which BDR to query
    let targetBdrId = bdrId;
    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      targetBdrId = userBdrId;
    } else if (!targetBdrId) {
      // Admin dashboard requests often omit bdr_id; default to the admin user's own rep id.
      const userBdrId = await getBdrIdFromUser();
      if (userBdrId) {
        targetBdrId = userBdrId;
      }
    }

    if (!targetBdrId) {
      return apiError('BDR ID is required', 400);
    }

    if (USE_LOCAL_DB) {
      // Local mode: use SQLite
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const today = new Date();
      const currentQuarter = getQuarterFromDate(today);
      // Use format() for local-date strings (toISOString uses UTC and can exclude last day of quarter in some timezones)
      const todayStr = format(today, 'yyyy-MM-dd');
      const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const currentMonthStr = format(currentMonthStart, 'yyyy-MM-dd');
      const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      const nextMonthStr = format(nextMonthStart, 'yyyy-MM-dd');
      const nextPayoutDate = new Date();
      nextPayoutDate.setDate(nextPayoutDate.getDate() + 30);
      const nextPayoutStr = format(nextPayoutDate, 'yyyy-MM-dd');
      const { start: quarterStart, end: quarterEnd } = parseQuarter(currentQuarter);
      const quarterStartStr = format(quarterStart, 'yyyy-MM-dd');
      const quarterEndStr = format(quarterEnd, 'yyyy-MM-dd');
      const yearStart = new Date(today.getFullYear(), 0, 1);
      const yearEnd = new Date(today.getFullYear(), 11, 31);
      const yearStartStr = format(yearStart, 'yyyy-MM-dd');
      const yearEndStr = format(yearEnd, 'yyyy-MM-dd');

      // Use prepared statements for better performance - execute all queries efficiently
      // Prepare statements once and reuse them
      const closedDealsStmt = db.prepare('SELECT COUNT(*) as count FROM deals WHERE bdr_id = ? AND status = ?');
      const quarterlySignedDealsStmt = db.prepare(`
        SELECT COALESCE(SUM(deal_value), 0) as total
        FROM deals
        WHERE bdr_id = ? AND status = 'closed-won'
        AND COALESCE(close_date, proposal_date) >= ? AND COALESCE(close_date, proposal_date) <= ?
      `);
      const commissionTotalsStmt = db.prepare(`
        SELECT 
          SUM(CASE WHEN ce.status = 'paid' THEN COALESCE(ce.amount, 0) ELSE 0 END) as earned,
          SUM(CASE WHEN ce.status = 'payable' AND ce.payable_date <= ? THEN COALESCE(ce.amount, 0) ELSE 0 END) as payable,
          SUM(CASE 
            WHEN ce.status IN ('payable', 'accrued') 
            AND (ce.invoiced_batch_id IS NULL OR cb.id IS NULL OR cb.status != 'approved')
            THEN COALESCE(ce.amount, 0) ELSE 0 
          END) as pending,
          SUM(CASE WHEN ce.status = 'accrued' THEN COALESCE(ce.amount, 0) ELSE 0 END) as accrued,
          SUM(CASE WHEN ce.accrual_date >= ? AND ce.accrual_date < ? THEN COALESCE(ce.amount, 0) ELSE 0 END) as accrued_this_month
        FROM commission_entries ce
        LEFT JOIN commission_batches cb ON ce.invoiced_batch_id = cb.id
        WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
      `);
      const quarterlyPerfStmt = db.prepare(`
        SELECT qp.revenue_collected, qp.achieved_percent, qp.bonus_eligible, qt.target_revenue
        FROM quarterly_performance qp
        LEFT JOIN quarterly_targets qt ON qp.quarter = qt.quarter AND qp.bdr_id = qt.bdr_id
        WHERE qp.bdr_id = ? AND qp.quarter = ?
      `);
      const commissionRulesStmt = db.prepare('SELECT quarterly_target FROM commission_rules ORDER BY updated_at DESC LIMIT 1');
      // Annual cash-collected metrics remain on collection_date basis.
      const annualRevenueStmt = db.prepare(`
        SELECT COALESCE(SUM(re.amount_collected), 0) as total
        FROM revenue_events re
        INNER JOIN deals d ON re.deal_id = d.id
        WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ?
        AND re.commissionable = 1
        AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
      `);
      const annualNewBusinessStmt = db.prepare(`
        SELECT COALESCE(SUM(re.amount_collected), 0) as total
        FROM revenue_events re
        INNER JOIN deals d ON re.deal_id = d.id
        WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ?
        AND re.commissionable = 1 AND re.billing_type != 'renewal'
        AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
      `);
      const annualRenewalUpliftStmt = db.prepare(`
        SELECT COALESCE(SUM(re.amount_collected), 0) as total
        FROM revenue_events re
        INNER JOIN deals d ON re.deal_id = d.id
        WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ?
        AND re.commissionable = 1 AND re.billing_type = 'renewal'
        AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
      `);
      // Total from approved commission batches (generated reports)
      const approvedBatchTotalStmt = db.prepare(`
        SELECT COALESCE(SUM(
          COALESCE(
            cbi.override_amount,
            CASE
              WHEN cbi.override_commission_rate IS NOT NULL AND COALESCE(re.amount_collected, 0) > 0
              THEN re.amount_collected * cbi.override_commission_rate
              ELSE COALESCE(ce.amount, 0)
            END
          )
        ), 0) as total
        FROM commission_batch_items cbi
        JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        JOIN commission_batches cb ON cbi.batch_id = cb.id
        WHERE cb.bdr_id = ? AND cb.status = 'approved'
      `);

      // Execute all queries (SQLite is synchronous, so this is as fast as it gets)
      const closedDealsCount = closedDealsStmt.get(targetBdrId, 'closed-won') as { count: number };
      const quarterlySignedDeals = quarterlySignedDealsStmt.get(targetBdrId, quarterStartStr, quarterEndStr) as { total: number };
      // Quarterly commission (bonus basis): deals with any payable_date in Q1.
      // Use total deal value (not cash collected): 2.5% of full service value for new, uplift only for renewals.
      const defaultRate = 0.025;
      const dealIdsWithPayableInQ1 = db.prepare(`
        SELECT DISTINCT ce.deal_id
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
          AND ce.payable_date >= ? AND ce.payable_date <= ?
          AND d.cancellation_date IS NULL
      `).all(targetBdrId, quarterStartStr, quarterEndStr) as { deal_id: string }[];
      const q1DealIds = [...new Set(dealIdsWithPayableInQ1.map((r) => r.deal_id))];

      let quarterlyCommissionOnClosedDeals = 0;
      let quarterlyCommissionBaseAmount = 0;

      if (q1DealIds.length > 0) {
        const placeholders = q1DealIds.map(() => '?').join(',');
        const services = db.prepare(`
          SELECT ds.deal_id, ds.commissionable_value, ds.commission_rate, ds.original_service_value, ds.is_renewal,
                 d.original_deal_value, d.deal_value, d.is_renewal as deal_is_renewal
          FROM deal_services ds
          INNER JOIN deals d ON ds.deal_id = d.id
          WHERE ds.deal_id IN (${placeholders})
        `).all(...q1DealIds) as Array<{
          deal_id: string;
          commissionable_value: number | null;
          commission_rate: number | null;
          original_service_value: number | null;
          is_renewal: number | null;
          original_deal_value: number | null;
          deal_value: number | null;
          deal_is_renewal: number | null;
        }>;

        const dealTotals = new Map<string, number>();
        for (const svc of services) {
          const cv = svc.commissionable_value ?? 0;
          dealTotals.set(svc.deal_id, (dealTotals.get(svc.deal_id) ?? 0) + cv);
        }

        for (const svc of services) {
          const isRenewal = svc.is_renewal === 1 || (svc.deal_is_renewal === 1 && (svc.original_deal_value ?? 0) > 0);
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
          quarterlyCommissionOnClosedDeals += baseAmount * rate;
          quarterlyCommissionBaseAmount += baseAmount;
        }

        const dealsWithServices = new Set(services.map((s) => s.deal_id));
        for (const dealId of q1DealIds) {
          if (dealsWithServices.has(dealId)) continue;
          const deal = db.prepare('SELECT deal_value, original_deal_value, is_renewal FROM deals WHERE id = ?').get(dealId) as {
            deal_value: number;
            original_deal_value: number | null;
            is_renewal: number;
          } | undefined;
          if (!deal) continue;
          const origDeal = deal.original_deal_value ?? 0;
          const dealVal = deal.deal_value ?? 0;
          const isRenewal = deal.is_renewal === 1 && origDeal > 0;
          const baseAmount = isRenewal ? Math.max(0, dealVal - origDeal) : dealVal;
          quarterlyCommissionOnClosedDeals += baseAmount * defaultRate;
          quarterlyCommissionBaseAmount += baseAmount;
        }
      }
      quarterlyCommissionOnClosedDeals = Number(quarterlyCommissionOnClosedDeals.toFixed(2));
      quarterlyCommissionBaseAmount = Number(quarterlyCommissionBaseAmount.toFixed(2));

      // Quarterly progress/bonus should use effective payable_date (default close+7 or app override).
      const year = today.getFullYear();
      const q1s = format(new Date(year, 0, 1), 'yyyy-MM-dd');
      const q1e = format(new Date(year, 2, 31), 'yyyy-MM-dd');
      const q2s = format(new Date(year, 3, 1), 'yyyy-MM-dd');
      const q2e = format(new Date(year, 5, 30), 'yyyy-MM-dd');
      const q3s = format(new Date(year, 6, 1), 'yyyy-MM-dd');
      const q3e = format(new Date(year, 8, 30), 'yyyy-MM-dd');
      const q4s = format(new Date(year, 9, 1), 'yyyy-MM-dd');
      const q4e = format(new Date(year, 11, 31), 'yyyy-MM-dd');
      const cr = commissionRulesStmt.get() as { quarterly_target: number } | undefined;
      const targetForQuarter = cr?.quarterly_target || 75000;
      const payableRowsForYear = fetchPayableBonusRowsLocal(
        db,
        targetBdrId,
        q1s,
        q4e
      ).rows;
      const {
        projectedBonusByQuarter: projectedCommissionByQuarter,
        progressByQuarter: quarterlyProgressByQuarter,
      } = buildQuarterlyPayableProgressFromRows(payableRowsForYear, year, todayStr, targetForQuarter);
      const ytdPayableRevenue = Number(
        payableRowsForYear
          .filter((r) => r.payable_date <= todayStr)
          .reduce((sum, r) => sum + (Number.parseFloat(r.attributed_revenue || '0') || 0), 0)
          .toFixed(2)
      );

      const totals = commissionTotalsStmt.get(nextPayoutStr, currentMonthStr, nextMonthStr, targetBdrId) as any;
      const quarterlyPerf = quarterlyPerfStmt.get(targetBdrId, currentQuarter) as any;
      const commissionRules = commissionRulesStmt.get() as { quarterly_target: number } | undefined;
      const annualRevenue = annualRevenueStmt.get(targetBdrId, yearStartStr, yearEndStr, todayStr) as { total: number };
      const annualNewBusiness = annualNewBusinessStmt.get(targetBdrId, yearStartStr, yearEndStr, todayStr) as { total: number };
      const annualRenewalUplift = annualRenewalUpliftStmt.get(targetBdrId, yearStartStr, yearEndStr, todayStr) as { total: number };
      const approvedBatchTotal = approvedBatchTotalStmt.get(targetBdrId) as { total: number };

      const earned = Number(approvedBatchTotal?.total ?? 0);
      const payable = Number(totals?.payable || 0);
      const pending = Number(totals?.pending || 0);
      const accrued = Number(totals?.accrued || 0);
      const accruedThisMonth = Number(totals?.accrued_this_month || 0);
      const currentQuarterProgress = quarterlyProgressByQuarter[currentQuarter] ?? {
        revenue: 0,
        commission: 0,
        bonus: 0,
        target: targetForQuarter,
        achievedPercent: 0,
      };
      const quarterlyRevenueCollected = Number(currentQuarterProgress.revenue || 0);
      const annualRevenueCollected = Number(annualRevenue?.total || 0);
      let quarterlyNewBusinessCollected = 0;
      let quarterlyRenewalUpliftCollected = 0;
      for (const row of payableRowsForYear) {
        if (row.payable_date > todayStr) continue;
        const q = row.payable_date.substring(0, 4) + '-Q' + Math.ceil(Number(row.payable_date.substring(5, 7)) / 3);
        if (q !== currentQuarter) continue;
        const revenue = Number.parseFloat(row.attributed_revenue || '0') || 0;
        if (row.billing_type === 'renewal') quarterlyRenewalUpliftCollected += revenue;
        else quarterlyNewBusinessCollected += revenue;
      }
      quarterlyNewBusinessCollected = Number(quarterlyNewBusinessCollected.toFixed(2));
      quarterlyRenewalUpliftCollected = Number(quarterlyRenewalUpliftCollected.toFixed(2));
      const annualNewBusinessCollected = Number(annualNewBusiness?.total || 0);
      const annualRenewalUpliftCollected = Number(annualRenewalUplift?.total || 0);
      const defaultQuarterlyTarget = commissionRules?.quarterly_target || 75000;
      const quarterlyTarget = quarterlyPerf?.target_revenue ?? defaultQuarterlyTarget;
      const quarterlyAchievedPercent = currentQuarterProgress.achievedPercent;

      // Expected quarterly bonus at 2.5% (extra on top of base commission)
      const quarterlySignedDealsValue = Number(quarterlySignedDeals?.total || 0);
      const expectedBonusOnSignedDeals = quarterlySignedDealsValue * 0.025;

      // Full-quarter bonus on effective payable_date basis (includes future payables in quarter).
      const projectedQuarterlyBonus = projectedCommissionByQuarter[currentQuarter] ?? 0;
      // Through-today bonus on effective payable_date basis (gate/progress parity).
      const expectedBonusOnCashCollected = Number((quarterlyRevenueCollected * 0.025).toFixed(2));

      // Calculate days elapsed and remaining for annual targets
      const yearStartTime = yearStart.getTime();
      const yearEndTime = yearEnd.getTime();
      const todayTime = today.getTime();
      const daysElapsed = Math.floor((todayTime - yearStartTime) / (1000 * 60 * 60 * 24)) + 1;
      const daysInYear = Math.floor((yearEndTime - yearStartTime) / (1000 * 60 * 60 * 24)) + 1;
      const daysRemaining = daysInYear - daysElapsed;

      // Annual target: $250,000
      const annualTarget = 250000;
      const annualAchievedPercent = annualTarget > 0 ? (annualRevenueCollected / annualTarget) * 100 : 0;

      // BHAG target: $800,000
      const bhagTarget = 800000;
      const bhagAchievedPercent = bhagTarget > 0 ? (annualRevenueCollected / bhagTarget) * 100 : 0;

      return apiSuccess({
        closedDeals: closedDealsCount?.count ?? 0,
        commissionEarned: Number(earned.toFixed(2)), // Legacy field name
        commissionAccrued: Number(accrued.toFixed(2)),
        commissionAccruedThisMonth: Number(accruedThisMonth.toFixed(2)),
        commissionPayable: Number(payable.toFixed(2)),
        commissionPaid: Number(earned.toFixed(2)),
        commissionPending: Number(pending.toFixed(2)), // Legacy field
        nextMonthPayout: Number(payable.toFixed(2)), // Legacy - kept for compatibility
        quarterlyCommissionOnClosedDeals,
        quarterlyCommissionBaseAmount: Number(quarterlyCommissionBaseAmount.toFixed(2)),
        projectedCommissionByQuarter,
        quarterlyProgressByQuarter,
        expectedBonusOnSignedDeals: Number(expectedBonusOnSignedDeals.toFixed(2)),
        expectedBonusOnCashCollected: Number(expectedBonusOnCashCollected.toFixed(2)),
        projectedQuarterlyBonus: Number(projectedQuarterlyBonus.toFixed(2)),
        ytdPayableRevenue,
        quarterlyProgress: {
          revenueCollected: quarterlyRevenueCollected,
          newBusinessCollected: quarterlyNewBusinessCollected,
          renewalUpliftCollected: quarterlyRenewalUpliftCollected,
          achievedPercent: Number(quarterlyAchievedPercent.toFixed(2)),
          bonusEligible: quarterlyRevenueCollected >= quarterlyTarget,
          target: quarterlyTarget,
        },
        annualProgress: {
          revenueCollected: annualRevenueCollected,
          newBusinessCollected: annualNewBusinessCollected,
          renewalUpliftCollected: annualRenewalUpliftCollected,
          target: annualTarget,
          achievedPercent: Number(annualAchievedPercent.toFixed(2)),
          daysElapsed,
          daysRemaining,
        },
        bhagProgress: {
          revenueCollected: annualRevenueCollected,
          newBusinessCollected: annualNewBusinessCollected,
          renewalUpliftCollected: annualRenewalUpliftCollected,
          target: bhagTarget,
          achievedPercent: Number(bhagAchievedPercent.toFixed(2)),
          daysElapsed,
          daysRemaining,
        },
      }, 200, { cache: 'no-store' }); // No cache - bonus fields must be fresh
    }

    // Supabase mode
    const supabase = await createClient();

    // Get closed deals count
    const countQuery = (supabase as any)
      .from('deals')
      .select('*', { count: 'exact', head: true })
      .eq('bdr_id', targetBdrId)
      .eq('status', 'closed-won');
    const countResult = await countQuery;
    const { count: closedDealsCount } = countResult as { count: number | null };

    // Get commission summary - use aggregate queries for better performance
    const today = new Date();
    const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const currentMonthStr = format(currentMonthStart, 'yyyy-MM-dd');
    const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthStr = format(nextMonthStart, 'yyyy-MM-dd');
    const nextPayoutDate = new Date();
    nextPayoutDate.setDate(nextPayoutDate.getDate() + 30);
    const nextPayoutStr = format(nextPayoutDate, 'yyyy-MM-dd');

    // Commission earned = total from approved commission batches (generated reports)
    const { data: approvedBatches } = await (supabase as any)
      .from('commission_batches')
      .select('id')
      .eq('bdr_id', targetBdrId)
      .eq('status', 'approved');
    const batchIds = (approvedBatches || []).map((b: any) => b.id);

    // Pending excludes entries in approved batches (already collected)
    const pendingFilter =
      batchIds.length > 0
        ? (supabase as any)
            .from('commission_entries')
            .select('amount, invoiced_batch_id')
            .eq('bdr_id', targetBdrId)
            .in('status', ['payable', 'accrued'])
            .neq('status', 'cancelled')
        : (supabase as any)
            .from('commission_entries')
            .select('amount')
            .eq('bdr_id', targetBdrId)
            .in('status', ['payable', 'accrued'])
            .neq('status', 'cancelled');

    const [payableResult, accruedResult, accruedThisMonthResult, pendingResult] = await Promise.all([
      // Payable entries (next payout)
      (supabase as any)
        .from('commission_entries')
        .select('amount')
        .eq('bdr_id', targetBdrId)
        .eq('status', 'payable')
        .lte('payable_date', nextPayoutStr)
        .neq('status', 'cancelled'),
      // Accrued entries (lifetime)
      (supabase as any)
        .from('commission_entries')
        .select('amount')
        .eq('bdr_id', targetBdrId)
        .eq('status', 'accrued')
        .neq('status', 'cancelled'),
      // Accrued this month
      (supabase as any)
        .from('commission_entries')
        .select('amount')
        .eq('bdr_id', targetBdrId)
        .eq('status', 'accrued')
        .gte('accrual_date', currentMonthStr)
        .lt('accrual_date', nextMonthStr)
        .neq('status', 'cancelled'),
      // Pending (payable + accrued, excluding entries in approved batches)
      pendingFilter,
    ]);
    let earned = 0;
    if (batchIds.length > 0) {
      const { data: batchItems } = await (supabase as any)
        .from('commission_batch_items')
        .select(`
          override_amount,
          override_commission_rate,
          commission_entries(amount, revenue_events(amount_collected))
        `)
        .in('batch_id', batchIds);
      for (const item of batchItems || []) {
        const ce = item.commission_entries;
        const ceObj = Array.isArray(ce) ? ce[0] : ce;
        const rev = ceObj?.revenue_events;
        const reObj = Array.isArray(rev) ? rev[0] : rev;
        const originalAmount = Number(ceObj?.amount ?? 0);
        const amountCollected = Number(reObj?.amount_collected ?? 0);
        let finalAmount = item.override_amount;
        if (finalAmount == null && item.override_commission_rate != null && amountCollected > 0) {
          finalAmount = amountCollected * item.override_commission_rate;
        }
        if (finalAmount == null) finalAmount = originalAmount;
        earned += Number(finalAmount ?? 0);
      }
    }
    const payable = (payableResult.data || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
    const accrued = (accruedResult.data || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
    const accruedThisMonth = (accruedThisMonthResult.data || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
    const pendingEntries = pendingResult.data || [];
    const pending =
      batchIds.length > 0
        ? pendingEntries
            .filter((e: any) => !e.invoiced_batch_id || !batchIds.includes(e.invoiced_batch_id))
            .reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0)
        : pendingEntries.reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);

    // Get current quarter performance
    const currentQuarter = getQuarterFromDate(new Date());
    const quarterlyPerfQuery = (supabase as any)
      .from('quarterly_performance')
      .select('revenue_collected, achieved_percent, bonus_eligible, quarterly_targets(target_revenue)')
      .eq('bdr_id', targetBdrId)
      .eq('quarter', currentQuarter)
      .single();
    const quarterlyPerfResult = await quarterlyPerfQuery;
    const { data: quarterlyPerf } = quarterlyPerfResult as { data: any | null };

    // Get quarterly target from commission rules as fallback
    const commissionRulesQuery = (supabase as any)
      .from('commission_rules')
      .select('quarterly_target')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    const commissionRulesResult = await commissionRulesQuery;
    const { data: commissionRules } = commissionRulesResult as { data: any | null };
    const defaultQuarterlyTarget = commissionRules?.quarterly_target || 75000;

    // All goal revenue from revenue_events (cash collected only)
    // Use parseQuarter for correct quarter boundaries (Q4 = Oct 1 - Dec 31); format() for local dates (avoids UTC excluding last day)
    const { start: quarterStart, end: quarterEnd } = parseQuarter(currentQuarter);
    const quarterStartStr = format(quarterStart, 'yyyy-MM-dd');
    const quarterEndStr = format(quarterEnd, 'yyyy-MM-dd');
    const yearStart = new Date(today.getFullYear(), 0, 1);
    const yearEnd = new Date(today.getFullYear(), 11, 31);
    const yearStartStr = format(yearStart, 'yyyy-MM-dd');
    const yearEndStr = format(yearEnd, 'yyyy-MM-dd');
    const todayStr = format(today, 'yyyy-MM-dd');
    // Cash collected: exclude revenue from cancelled deals where collection_date >= cancellation_date (those payments would not have been received)
    // Fetch events with deal's cancellation_date, then filter in JS (PostgREST doesn't support cross-column comparison easily)
    const filterCollected = (rows: any[]) =>
      (rows || []).filter((e: any) => {
        const d = Array.isArray(e.deals) ? e.deals[0] : e.deals;
        const cancel = d?.cancellation_date;
        return !cancel || (e.collection_date && e.collection_date < cancel);
      });

    const year = today.getFullYear();
    const q1s = format(new Date(year, 0, 1), 'yyyy-MM-dd');
    const q1e = format(new Date(year, 2, 31), 'yyyy-MM-dd');
    const q2s = format(new Date(year, 3, 1), 'yyyy-MM-dd');
    const q2e = format(new Date(year, 5, 30), 'yyyy-MM-dd');
    const q3s = format(new Date(year, 6, 1), 'yyyy-MM-dd');
    const q3e = format(new Date(year, 8, 30), 'yyyy-MM-dd');
    const q4s = format(new Date(year, 9, 1), 'yyyy-MM-dd');
    const q4e = format(new Date(year, 11, 31), 'yyyy-MM-dd');

    const [annualRows, payableRowsForYearResult] = await Promise.all([
      (supabase as any)
        .from('revenue_events')
        .select('amount_collected, collection_date, billing_type, deals!inner(cancellation_date)')
        .eq('bdr_id', targetBdrId)
        .gte('collection_date', yearStartStr)
        .lte('collection_date', yearEndStr)
        .lte('collection_date', todayStr)
        .eq('commissionable', true),
      fetchPayableBonusRowsSupabase(supabase, targetBdrId, q1s, q4e),
    ]);

    const annualFiltered = filterCollected((annualRows as any).data);
    const payableRowsForYear = payableRowsForYearResult.rows;

    const annualRevenueCollected = annualFiltered.reduce(
      (sum: number, e: any) => sum + Number(e.amount_collected || 0),
      0
    );
    const annualNewBusinessCollected = annualFiltered
      .filter((e: any) => e.billing_type !== 'renewal')
      .reduce((sum: number, e: any) => sum + Number(e.amount_collected || 0), 0);
    const annualRenewalUpliftCollected = annualFiltered
      .filter((e: any) => e.billing_type === 'renewal')
      .reduce((sum: number, e: any) => sum + Number(e.amount_collected || 0), 0);

    const quarterlyTarget = quarterlyPerf?.quarterly_targets?.target_revenue ?? defaultQuarterlyTarget;
    const {
      projectedBonusByQuarter: projectedCommissionByQuarterSupabase,
      progressByQuarter: quarterlyProgressByQuarterSupabase,
    } = buildQuarterlyPayableProgressFromRows(payableRowsForYear, year, todayStr, quarterlyTarget);
    const ytdPayableRevenue = Number(
      payableRowsForYear
        .filter((r) => r.payable_date <= todayStr)
        .reduce((sum, r) => sum + (Number.parseFloat(r.attributed_revenue || '0') || 0), 0)
        .toFixed(2)
    );
    const currentQuarterProgress = quarterlyProgressByQuarterSupabase[currentQuarter] ?? {
      revenue: 0,
      commission: 0,
      bonus: 0,
      target: quarterlyTarget,
      achievedPercent: 0,
    };
    const quarterlyRevenueCollected = Number(currentQuarterProgress.revenue || 0);
    const quarterlyAchievedPercent = currentQuarterProgress.achievedPercent;
    let quarterlyNewBusinessCollected = 0;
    let quarterlyRenewalUpliftCollected = 0;
    for (const row of payableRowsForYear) {
      if (row.payable_date > todayStr) continue;
      const q = row.payable_date.substring(0, 4) + '-Q' + Math.ceil(Number(row.payable_date.substring(5, 7)) / 3);
      if (q !== currentQuarter) continue;
      const revenue = Number.parseFloat(row.attributed_revenue || '0') || 0;
      if (row.billing_type === 'renewal') quarterlyRenewalUpliftCollected += revenue;
      else quarterlyNewBusinessCollected += revenue;
    }
    quarterlyNewBusinessCollected = Number(quarterlyNewBusinessCollected.toFixed(2));
    quarterlyRenewalUpliftCollected = Number(quarterlyRenewalUpliftCollected.toFixed(2));

    // Quarterly signed deals value (deals closed this quarter) - for bonus-on-signed calculation
    const signedDealsResult = await (supabase as any)
      .from('deals')
      .select('deal_value, close_date, proposal_date')
      .eq('bdr_id', targetBdrId)
      .eq('status', 'closed-won');
    const signedDeals = (signedDealsResult.data || []) as Array<{ deal_value: number; close_date: string | null; proposal_date: string }>;
    const quarterlySignedDealsValue = signedDeals.reduce((sum, d) => {
      const signDate = d.close_date || d.proposal_date;
      if (!signDate) return sum;
      const dateStr = signDate.split('T')[0];
      if (dateStr >= quarterStartStr && dateStr <= quarterEndStr) return sum + Number(d.deal_value || 0);
      return sum;
    }, 0);

    // Quarterly commission (bonus basis): deals with any payable_date in Q1.
    // Use total deal value (not cash collected): 2.5% of full service value for new, uplift only for renewals.
    const quarterlyCeResult = await (supabase as any)
      .from('commission_entries')
      .select('deal_id')
      .eq('bdr_id', targetBdrId)
      .neq('status', 'cancelled')
      .gte('payable_date', quarterStartStr)
      .lte('payable_date', quarterEndStr);
    const quarterlyCeRows = (quarterlyCeResult.data || []) as Array<{ deal_id: string }>;
    const q1DealIdsSupabase = [...new Set(quarterlyCeRows.map((r) => r.deal_id))];

    let quarterlyCommissionOnClosedDeals = 0;
    let quarterlyCommissionBaseAmount = 0;

    if (q1DealIdsSupabase.length > 0) {
      const { data: cancelledDeals } = await (supabase as any)
        .from('deals')
        .select('id')
        .in('id', q1DealIdsSupabase)
        .not('cancellation_date', 'is', null);
      const cancelledSet = new Set((cancelledDeals || []).map((d: any) => d.id));
      const activeDealIds = q1DealIdsSupabase.filter((id) => !cancelledSet.has(id));

      if (activeDealIds.length > 0) {
        const { data: dealServices } = await (supabase as any)
          .from('deal_services')
          .select('deal_id, commissionable_value, commission_rate, original_service_value, is_renewal, deals(original_deal_value, deal_value, is_renewal)')
          .in('deal_id', activeDealIds);
        const services = (dealServices || []) as Array<{
          deal_id: string;
          commissionable_value: number | null;
          commission_rate: number | null;
          original_service_value: number | null;
          is_renewal: number | null;
          deals: { original_deal_value: number | null; deal_value: number; is_renewal: number } | null;
        }>;

        const dealTotals = new Map<string, number>();
        for (const svc of services) {
          const cv = svc.commissionable_value ?? 0;
          dealTotals.set(svc.deal_id, (dealTotals.get(svc.deal_id) ?? 0) + cv);
        }

        const defaultRateSupabase = 0.025;
        for (const svc of services) {
          const dealObj = Array.isArray(svc.deals) ? svc.deals[0] : svc.deals;
          const origDeal = dealObj?.original_deal_value ?? 0;
          const dealVal = dealObj?.deal_value ?? 0;
          const dealIsRenewal = dealObj?.is_renewal === 1;
          const isRenewal = svc.is_renewal === 1 || (dealIsRenewal && origDeal > 0);
          const rate = svc.commission_rate ?? defaultRateSupabase;
          const commVal = Number(svc.commissionable_value ?? 0);
          const origSvc = Number(svc.original_service_value ?? 0);
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
          quarterlyCommissionOnClosedDeals += baseAmount * rate;
          quarterlyCommissionBaseAmount += baseAmount;
        }

        const dealsWithServices = new Set(services.map((s) => s.deal_id));
        for (const dealId of activeDealIds) {
          if (dealsWithServices.has(dealId)) continue;
          const { data: dealRow } = await (supabase as any)
            .from('deals')
            .select('deal_value, original_deal_value, is_renewal')
            .eq('id', dealId)
            .single();
          if (!dealRow) continue;
          const origDeal = dealRow.original_deal_value ?? 0;
          const dealVal = dealRow.deal_value ?? 0;
          const isRenewal = dealRow.is_renewal === 1 && origDeal > 0;
          const baseAmount = isRenewal ? Math.max(0, dealVal - origDeal) : dealVal;
          quarterlyCommissionOnClosedDeals += baseAmount * defaultRateSupabase;
          quarterlyCommissionBaseAmount += baseAmount;
        }
      }
    }
    quarterlyCommissionOnClosedDeals = Number(quarterlyCommissionOnClosedDeals.toFixed(2));
    quarterlyCommissionBaseAmount = Number(quarterlyCommissionBaseAmount.toFixed(2));

    // Expected quarterly bonus at 2.5% (extra on top of base commission)
    const expectedBonusOnSignedDeals = quarterlySignedDealsValue * 0.025;

    // Full-quarter bonus on effective payable_date basis (includes future payables in quarter).
    const projectedQuarterlyBonus = projectedCommissionByQuarterSupabase[currentQuarter] ?? 0;
    // Through-today bonus on effective payable_date basis (gate/progress parity).
    const expectedBonusOnCashCollected = Number((quarterlyRevenueCollected * 0.025).toFixed(2));

    // Calculate days elapsed and remaining for annual targets
    const yearStartTime = yearStart.getTime();
    const yearEndTime = yearEnd.getTime();
    const todayTime = today.getTime();
    const daysElapsed = Math.floor((todayTime - yearStartTime) / (1000 * 60 * 60 * 24)) + 1;
    const daysInYear = Math.floor((yearEndTime - yearStartTime) / (1000 * 60 * 60 * 24)) + 1;
    const daysRemaining = daysInYear - daysElapsed;

    // Annual target: $250,000
    const annualTarget = 250000;
    const annualAchievedPercent = annualTarget > 0 ? (annualRevenueCollected / annualTarget) * 100 : 0;

    // BHAG target: $800,000
    const bhagTarget = 800000;
    const bhagAchievedPercent = bhagTarget > 0 ? (annualRevenueCollected / bhagTarget) * 100 : 0;

    return apiSuccess({
      closedDeals: closedDealsCount ?? 0,
      commissionEarned: Number(earned.toFixed(2)), // Legacy field name
      commissionAccrued: Number(accrued.toFixed(2)),
      commissionAccruedThisMonth: Number(accruedThisMonth.toFixed(2)),
      commissionPayable: Number(payable.toFixed(2)),
      commissionPaid: Number(earned.toFixed(2)),
      commissionPending: Number(pending.toFixed(2)), // Legacy field
      nextMonthPayout: Number(payable.toFixed(2)), // Legacy field
      quarterlyCommissionOnClosedDeals,
      quarterlyCommissionBaseAmount,
      projectedCommissionByQuarter: projectedCommissionByQuarterSupabase,
      quarterlyProgressByQuarter: quarterlyProgressByQuarterSupabase,
      expectedBonusOnSignedDeals: Number(expectedBonusOnSignedDeals.toFixed(2)),
      expectedBonusOnCashCollected: Number(expectedBonusOnCashCollected.toFixed(2)),
      projectedQuarterlyBonus: Number(projectedQuarterlyBonus.toFixed(2)),
      ytdPayableRevenue,
      quarterlyProgress: {
        revenueCollected: Number(quarterlyRevenueCollected.toFixed(2)),
        newBusinessCollected: Number(quarterlyNewBusinessCollected.toFixed(2)),
        renewalUpliftCollected: Number(quarterlyRenewalUpliftCollected.toFixed(2)),
        achievedPercent: Number(quarterlyAchievedPercent.toFixed(2)),
        bonusEligible: quarterlyRevenueCollected >= quarterlyTarget,
        target: quarterlyTarget,
      },
      annualProgress: {
        revenueCollected: Number(annualRevenueCollected.toFixed(2)),
        newBusinessCollected: Number(annualNewBusinessCollected.toFixed(2)),
        renewalUpliftCollected: Number(annualRenewalUpliftCollected.toFixed(2)),
        target: annualTarget,
        achievedPercent: Number(annualAchievedPercent.toFixed(2)),
        daysElapsed,
        daysRemaining,
      },
      bhagProgress: {
        revenueCollected: Number(annualRevenueCollected.toFixed(2)),
        newBusinessCollected: Number(annualNewBusinessCollected.toFixed(2)),
        renewalUpliftCollected: Number(annualRenewalUpliftCollected.toFixed(2)),
        target: bhagTarget,
        achievedPercent: Number(bhagAchievedPercent.toFixed(2)),
        daysElapsed,
        daysRemaining,
      },
    }, 200, { cache: 'no-store' }); // No cache - bonus fields must be fresh
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}




