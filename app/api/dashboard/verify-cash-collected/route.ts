/**
 * GET /api/dashboard/verify-cash-collected
 *
 * Verification endpoint - runs the exact dashboard logic and returns a detailed
 * report so you can confirm cash collected is calculated correctly.
 * Requires auth. Uses your BDR ID (or bdr_id param if admin).
 */

import { NextRequest } from 'next/server';
import { format } from 'date-fns';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { getQuarterFromDate, parseQuarter } from '@/lib/commission/calculator';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrIdParam = searchParams.get('bdr_id');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    let targetBdrId = bdrIdParam;
    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) return apiError('BDR profile not found', 404);
      targetBdrId = userBdrId;
    }
    if (!targetBdrId) return apiError('BDR ID is required', 400);

    if (!USE_LOCAL_DB) {
      return apiError('Verification only supported for local DB. Use scripts/verify-cash-collected.ts for Supabase.', 400);
    }

    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

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

    // Dashboard query (exact copy) - excludes revenue from cancelled deals where collection_date >= cancellation_date
    const dashboardQuarterly = db
      .prepare(
        `SELECT COALESCE(SUM(re.amount_collected), 0) as total, COUNT(*) as cnt
       FROM revenue_events re
       INNER JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ? AND re.commissionable = 1
       AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)`
      )
      .get(targetBdrId, quarterStartStr, quarterEndStr, todayStr) as { total: number; cnt: number };

    const dashboardAnnual = db
      .prepare(
        `SELECT COALESCE(SUM(re.amount_collected), 0) as total, COUNT(*) as cnt
       FROM revenue_events re
       INNER JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ? AND re.commissionable = 1
       AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)`
      )
      .get(targetBdrId, yearStartStr, yearEndStr, todayStr) as { total: number; cnt: number };

    // Reference: quarter range WITHOUT today cap (shows impact of today cap)
    const quarterNoCap = db
      .prepare(
        `SELECT COALESCE(SUM(re.amount_collected), 0) as total, COUNT(*) as cnt
       FROM revenue_events re
       INNER JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.commissionable = 1
       AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)`
      )
      .get(targetBdrId, quarterStartStr, quarterEndStr) as { total: number; cnt: number };

    // Reference: all time for this BDR (sanity check)
    const allTime = db
      .prepare(
        `SELECT COALESCE(SUM(re.amount_collected), 0) as total, COUNT(*) as cnt
       FROM revenue_events re
       INNER JOIN deals d ON re.deal_id = d.id
       WHERE re.bdr_id = ? AND re.commissionable = 1
       AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)`
      )
      .get(targetBdrId) as { total: number; cnt: number };

    const quarterlyDashboard = Number(dashboardQuarterly?.total || 0);
    const annualDashboard = Number(dashboardAnnual?.total || 0);
    const quarterlyNoCapTotal = Number(quarterNoCap?.total || 0);
    const quarterlyNoCapCnt = Number(quarterNoCap?.cnt || 0);
    const excludedByTodayCap = quarterlyNoCapTotal - quarterlyDashboard;
    const excludedEventCount = (quarterlyNoCapCnt || 0) - (dashboardQuarterly?.cnt || 0);

    return apiSuccess(
      {
        bdrId: targetBdrId,
        date: todayStr,
        quarter: currentQuarter,
        quarterRange: { start: quarterStartStr, end: quarterEndStr },
        yearRange: { start: yearStartStr, end: yearEndStr },
        dashboardResults: {
          quarterlyCashCollected: Number(quarterlyDashboard.toFixed(2)),
          annualCashCollected: Number(annualDashboard.toFixed(2)),
          quarterlyEventCount: dashboardQuarterly?.cnt ?? 0,
          annualEventCount: dashboardAnnual?.cnt ?? 0,
        },
        filtersApplied: {
          collection_date: `>= ${quarterStartStr} AND <= ${quarterEndStr} AND <= ${todayStr} (quarter + cap at today)`,
          commissionable: 1,
          bdr_id: targetBdrId,
          cancelled_deals: 'Excluded: revenue where deal.cancellation_date <= collection_date (payment not received)',
        },
        reference: {
          quarterWithoutTodayCap: {
            total: Number(quarterlyNoCapTotal.toFixed(2)),
            eventCount: quarterlyNoCapCnt,
            note: 'If this is higher, the today cap is excluding future-dated revenue',
          },
          excludedByTodayCap: {
            amount: Number(excludedByTodayCap.toFixed(2)),
            eventCount: excludedEventCount,
            note: 'Revenue with collection_date > today is excluded (correct - not yet collected)',
          },
          allTimeTotal: Number(Number(allTime?.total || 0).toFixed(2)),
          allTimeEventCount: allTime?.cnt ?? 0,
        },
        verification: 'Dashboard uses: SUM(amount_collected) WHERE bdr_id, date in range, date<=today, commissionable=1, exclude cancelled-deal revenue (collection_date >= cancellation_date)',
      },
      200,
      { cache: 'no-store' }
    );
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}
