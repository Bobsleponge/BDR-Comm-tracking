import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { parseQuarter } from '@/lib/commission/calculator';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bdrId: string; quarter: string }> }
) {
  try {
    await requireAuth();
    const { bdrId, quarter } = await params;

    if (!(await canAccessBdr(bdrId))) {
      return apiError('Forbidden', 403);
    }

    // Get quarter date range
    const { start, end } = parseQuarter(quarter);
    const quarterStartStr = start.toISOString().split('T')[0];
    const quarterEndStr = end.toISOString().split('T')[0];

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Get quarterly performance
      const perf = db.prepare(`
        SELECT qp.*, qt.target_revenue, br.name, br.email
        FROM quarterly_performance qp
        LEFT JOIN quarterly_targets qt ON qp.bdr_id = qt.bdr_id AND qp.quarter = qt.quarter
        LEFT JOIN bdr_reps br ON qp.bdr_id = br.id
        WHERE qp.bdr_id = ? AND qp.quarter = ?
      `).get(bdrId, quarter) as any;

      // Calculate revenue from revenue_events
      const revenueEvents = db.prepare(`
        SELECT COALESCE(SUM(amount_collected), 0) as total
        FROM revenue_events
        WHERE bdr_id = ? AND collection_date >= ? AND collection_date <= ? AND commissionable = 1
      `).get(bdrId, quarterStartStr, quarterEndStr) as { total: number };

      const calculatedRevenue = revenueEvents?.total || 0;

      // Use calculated revenue if performance record doesn't exist or revenue is 0
      const revenueCollected = (perf && perf.revenue_collected > 0) 
        ? perf.revenue_collected 
        : calculatedRevenue;

      if (!perf) {
        return apiError('Quarterly performance not found', 404);
      }

      return apiSuccess({
        ...perf,
        revenue_collected: revenueCollected,
        calculated_revenue: calculatedRevenue,
      });
    }

    const supabase = await createClient();

    // Get quarterly performance
    const query = (supabase as any)
      .from('quarterly_performance')
      .select('*, bdr_reps(name, email), quarterly_targets(target_revenue)')
      .eq('bdr_id', bdrId)
      .eq('quarter', quarter)
      .single();
    const result = await query;
    const { data: perf, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 404);
    }

    // Calculate revenue from revenue_events
    const revenueEventsQuery = (supabase as any)
      .from('revenue_events')
      .select('amount_collected')
      .eq('bdr_id', bdrId)
      .gte('collection_date', quarterStartStr)
      .lte('collection_date', quarterEndStr)
      .eq('commissionable', true);
    
    const { data: revenueEvents } = (await revenueEventsQuery) as { data: any[] | null };
    const calculatedRevenue = (revenueEvents || []).reduce(
      (sum: number, e: any) => sum + Number(e.amount_collected || 0),
      0
    );

    // Use calculated revenue if performance record revenue is 0
    const revenueCollected = (perf.revenue_collected > 0) 
      ? perf.revenue_collected 
      : calculatedRevenue;

    return apiSuccess({
      ...perf,
      revenue_collected: revenueCollected,
      calculated_revenue: calculatedRevenue,
    });
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}



