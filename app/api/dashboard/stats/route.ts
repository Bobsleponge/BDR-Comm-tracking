import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { getQuarterFromDate } from '@/lib/commission/calculator';

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
    }

    if (!targetBdrId) {
      return apiError('BDR ID is required', 400);
    }

    if (USE_LOCAL_DB) {
      // Local mode: use SQLite
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const currentQuarter = getQuarterFromDate(new Date());
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      
      // Pre-calculate all date strings once
      const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const currentMonthStr = currentMonthStart.toISOString().split('T')[0];
      const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      const nextMonthStr = nextMonthStart.toISOString().split('T')[0];
      const nextPayoutDate = new Date();
      nextPayoutDate.setDate(nextPayoutDate.getDate() + 30);
      const nextPayoutStr = nextPayoutDate.toISOString().split('T')[0];
      const quarterStart = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
      const quarterEnd = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3 + 3, 0);
      const quarterStartStr = quarterStart.toISOString().split('T')[0];
      const quarterEndStr = quarterEnd.toISOString().split('T')[0];
      const yearStart = new Date(today.getFullYear(), 0, 1);
      const yearEnd = new Date(today.getFullYear(), 11, 31);
      const yearStartStr = yearStart.toISOString().split('T')[0];
      const yearEndStr = yearEnd.toISOString().split('T')[0];

      // Use prepared statements for better performance - execute all queries efficiently
      // Prepare statements once and reuse them
      const closedDealsStmt = db.prepare('SELECT COUNT(*) as count FROM deals WHERE bdr_id = ? AND status = ?');
      const commissionTotalsStmt = db.prepare(`
        SELECT 
          SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) as earned,
          SUM(CASE WHEN status = 'payable' AND payable_date <= ? THEN amount ELSE 0 END) as payable,
          SUM(CASE WHEN status IN ('payable', 'accrued') THEN amount ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'accrued' THEN amount ELSE 0 END) as accrued,
          SUM(CASE WHEN accrual_date >= ? AND accrual_date < ? THEN amount ELSE 0 END) as accrued_this_month
        FROM commission_entries 
        WHERE bdr_id = ? AND status != 'cancelled'
      `);
      const quarterlyPerfStmt = db.prepare(`
        SELECT qp.revenue_collected, qp.achieved_percent, qp.bonus_eligible, qt.target_revenue
        FROM quarterly_performance qp
        LEFT JOIN quarterly_targets qt ON qp.quarter = qt.quarter AND qp.bdr_id = qt.bdr_id
        WHERE qp.bdr_id = ? AND qp.quarter = ?
      `);
      const commissionRulesStmt = db.prepare('SELECT quarterly_target FROM commission_rules ORDER BY updated_at DESC LIMIT 1');
      const quarterlyRevenueStmt = db.prepare(`
        SELECT COALESCE(SUM(amount_collected), 0) as total
        FROM revenue_events
        WHERE bdr_id = ? AND collection_date >= ? AND collection_date <= ? AND collection_date <= ? AND commissionable = 1
      `);
      const annualRevenueStmt = db.prepare(`
        SELECT COALESCE(SUM(amount_collected), 0) as total
        FROM revenue_events
        WHERE bdr_id = ? AND collection_date >= ? AND collection_date <= ? AND collection_date <= ? AND commissionable = 1
      `);

      // Execute all queries (SQLite is synchronous, so this is as fast as it gets)
      const closedDealsCount = closedDealsStmt.get(targetBdrId, 'closed-won') as { count: number };
      const totals = commissionTotalsStmt.get(nextPayoutStr, currentMonthStr, nextMonthStr, targetBdrId) as any;
      const quarterlyPerf = quarterlyPerfStmt.get(targetBdrId, currentQuarter) as any;
      const commissionRules = commissionRulesStmt.get() as { quarterly_target: number } | undefined;
      const quarterlyRevenue = quarterlyRevenueStmt.get(targetBdrId, quarterStartStr, quarterEndStr, todayStr) as { total: number };
      const annualRevenue = annualRevenueStmt.get(targetBdrId, yearStartStr, yearEndStr, todayStr) as { total: number };

      const earned = Number(totals?.earned || 0);
      const payable = Number(totals?.payable || 0);
      const pending = Number(totals?.pending || 0);
      const accrued = Number(totals?.accrued || 0);
      const accruedThisMonth = Number(totals?.accrued_this_month || 0);
      const quarterlyRevenueCollected = Number(quarterlyRevenue?.total || 0);
      const annualRevenueCollected = Number(annualRevenue?.total || 0);
      const defaultQuarterlyTarget = commissionRules?.quarterly_target || 75000;
      const quarterlyTarget = quarterlyPerf?.target_revenue ?? defaultQuarterlyTarget;
      const quarterlyAchievedPercent = quarterlyTarget > 0 ? (quarterlyRevenueCollected / quarterlyTarget) * 100 : 0;

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
        nextMonthPayout: Number(payable.toFixed(2)), // Legacy field - use payable for now
        quarterlyProgress: {
          revenueCollected: quarterlyRevenueCollected,
          achievedPercent: Number(quarterlyAchievedPercent.toFixed(2)),
          bonusEligible: quarterlyPerf?.bonus_eligible ? true : false,
          target: quarterlyTarget,
        },
        annualProgress: {
          revenueCollected: annualRevenueCollected,
          target: annualTarget,
          achievedPercent: Number(annualAchievedPercent.toFixed(2)),
          daysElapsed,
          daysRemaining,
        },
        bhagProgress: {
          revenueCollected: annualRevenueCollected,
          target: bhagTarget,
          achievedPercent: Number(bhagAchievedPercent.toFixed(2)),
          daysElapsed,
          daysRemaining,
        },
      }, 200, { cache: 60 }); // Increased cache to 60 seconds for better performance
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
    const currentMonthStr = currentMonthStart.toISOString().split('T')[0];
    const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthStr = nextMonthStart.toISOString().split('T')[0];
    const nextPayoutDate = new Date();
    nextPayoutDate.setDate(nextPayoutDate.getDate() + 30);
    const nextPayoutStr = nextPayoutDate.toISOString().split('T')[0];

    // Use RPC function or multiple optimized queries instead of fetching all entries
    // For now, use optimized queries with filters
    const [earnedResult, payableResult, accruedResult, accruedThisMonthResult, pendingResult] = await Promise.all([
      // Paid entries
      (supabase as any)
        .from('commission_entries')
        .select('amount')
        .eq('bdr_id', targetBdrId)
        .eq('status', 'paid')
        .neq('status', 'cancelled'),
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
      // Pending (legacy - payable + accrued)
      (supabase as any)
        .from('commission_entries')
        .select('amount')
        .eq('bdr_id', targetBdrId)
        .in('status', ['payable', 'accrued'])
        .neq('status', 'cancelled'),
    ]);

    const earned = (earnedResult.data || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
    const payable = (payableResult.data || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
    const accrued = (accruedResult.data || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
    const accruedThisMonth = (accruedThisMonthResult.data || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
    const pending = (pendingResult.data || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);

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

    // Get quarterly revenue from revenue_events
    const quarterStart = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
    const quarterEnd = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3 + 3, 0);
    const quarterStartStr = quarterStart.toISOString().split('T')[0];
    const quarterEndStr = quarterEnd.toISOString().split('T')[0];

    const todayStr = today.toISOString().split('T')[0];
    const quarterlyRevenueQuery = (supabase as any)
      .from('revenue_events')
      .select('amount_collected')
      .eq('bdr_id', targetBdrId)
      .gte('collection_date', quarterStartStr)
      .lte('collection_date', quarterEndStr)
      .lte('collection_date', todayStr)
      .eq('commissionable', true);
    const quarterlyRevenueResult = await quarterlyRevenueQuery;
    const { data: quarterlyRevenueData } = quarterlyRevenueResult as { data: any[] | null };
    const quarterlyRevenue = (quarterlyRevenueData || []).reduce(
      (sum: number, e: any) => sum + Number(e.amount_collected || 0),
      0
    );

    // Always calculate quarterly progress, even if no performance record exists
    const quarterlyRevenueCollected = Number(quarterlyRevenue || 0);
    const quarterlyTarget = quarterlyPerf?.quarterly_targets?.target_revenue ?? defaultQuarterlyTarget;
    const quarterlyAchievedPercent = quarterlyTarget > 0 ? (quarterlyRevenueCollected / quarterlyTarget) * 100 : 0;

    // Calculate annual revenue (current calendar year, only collected revenue)
    const yearStart = new Date(today.getFullYear(), 0, 1);
    const yearEnd = new Date(today.getFullYear(), 11, 31);
    const yearStartStr = yearStart.toISOString().split('T')[0];
    const yearEndStr = yearEnd.toISOString().split('T')[0];

    const annualRevenueQuery = (supabase as any)
      .from('revenue_events')
      .select('amount_collected')
      .eq('bdr_id', targetBdrId)
      .gte('collection_date', yearStartStr)
      .lte('collection_date', yearEndStr)
      .lte('collection_date', todayStr)
      .eq('commissionable', true);
    const annualRevenueResult = await annualRevenueQuery;
    const { data: annualRevenueData } = annualRevenueResult as { data: any[] | null };
    const annualRevenueCollected = (annualRevenueData || []).reduce(
      (sum: number, e: any) => sum + Number(e.amount_collected || 0),
      0
    );

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
      nextMonthPayout: Number(payable.toFixed(2)), // Legacy field - use payable for now
      quarterlyProgress: {
        revenueCollected: Number(quarterlyRevenueCollected.toFixed(2)),
        achievedPercent: Number(quarterlyAchievedPercent.toFixed(2)),
        bonusEligible: quarterlyPerf?.bonus_eligible || false,
        target: quarterlyTarget,
      },
      annualProgress: {
        revenueCollected: Number(annualRevenueCollected.toFixed(2)),
        target: annualTarget,
        achievedPercent: Number(annualAchievedPercent.toFixed(2)),
        daysElapsed,
        daysRemaining,
      },
      bhagProgress: {
        revenueCollected: Number(annualRevenueCollected.toFixed(2)),
        target: bhagTarget,
        achievedPercent: Number(bhagAchievedPercent.toFixed(2)),
        daysElapsed,
        daysRemaining,
      },
    }, 200, { cache: 30 }); // Cache for 30 seconds
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}




