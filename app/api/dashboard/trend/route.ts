import { NextRequest } from 'next/server';
import { format, subMonths } from 'date-fns';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

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

    const today = new Date();
    const twelveMonthsAgo = subMonths(today, 11);
    const startStr = format(twelveMonthsAgo, 'yyyy-MM-01');
    const endStr = format(today, 'yyyy-MM-dd');

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const rows = db
        .prepare(
          `SELECT strftime('%Y-%m', re.collection_date) as month, COALESCE(SUM(re.amount_collected), 0) as amount
           FROM revenue_events re
           INNER JOIN deals d ON re.deal_id = d.id
           WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.commissionable = 1
           AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
           GROUP BY strftime('%Y-%m', re.collection_date)
           ORDER BY month ASC`
        )
        .all(targetBdrId, startStr, endStr) as Array<{ month: string; amount: number }>;

      // Fill in missing months with 0
      const byMonth = new Map<string, number>();
      for (let i = 0; i < 12; i++) {
        const d = subMonths(today, 11 - i);
        byMonth.set(format(d, 'yyyy-MM'), 0);
      }
      for (const r of rows) {
        byMonth.set(r.month, Number(r.amount || 0));
      }

      const data = Array.from(byMonth.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, amount]) => ({ month, amount }));

      return apiSuccess(data, 200, { cache: 'no-store' });
    }

    // Supabase mode
    const supabase = await createClient();

    const { data: events } = await (supabase as any)
      .from('revenue_events')
      .select('collection_date, amount_collected, deals!inner(cancellation_date)')
      .eq('bdr_id', targetBdrId)
      .gte('collection_date', startStr)
      .lte('collection_date', endStr)
      .eq('commissionable', true);

    const byMonth = new Map<string, number>();
    for (let i = 0; i < 12; i++) {
      const d = subMonths(today, 11 - i);
      byMonth.set(format(d, 'yyyy-MM'), 0);
    }

    for (const e of events || []) {
      const dateStr = e.collection_date?.split('T')[0] || e.collection_date;
      if (!dateStr) continue;
      const d = Array.isArray(e.deals) ? e.deals[0] : e.deals;
      const cancel = d?.cancellation_date;
      if (cancel && dateStr >= cancel) continue; // Exclude: collected on or after cancellation
      const month = dateStr.substring(0, 7);
      const amt = Number(e.amount_collected || 0);
      byMonth.set(month, (byMonth.get(month) || 0) + amt);
    }

    const data = Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, amount]) => ({ month, amount }));

    return apiSuccess(data, 200, { cache: 'no-store' });
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}
