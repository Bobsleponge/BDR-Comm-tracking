import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { loadCommissionBucketsLocal } from '@/lib/dashboard/dashboard-metrics';
import { format } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '10', 10);
    const today = new Date();
    const currentMonthStr = format(new Date(today.getFullYear(), today.getMonth(), 1), 'yyyy-MM-dd');
    const nextMonthStr = format(new Date(today.getFullYear(), today.getMonth() + 1, 1), 'yyyy-MM-dd');
    const nextPayoutDate = new Date(today);
    nextPayoutDate.setDate(nextPayoutDate.getDate() + 30);
    const nextPayoutStr = format(nextPayoutDate, 'yyyy-MM-dd');

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const reps = db.prepare('SELECT id, name, email, status FROM bdr_reps').all() as Array<{
        id: string;
        name: string;
        email: string;
        status: string;
      }>;

      const repStats = reps.map((rep) => {
        const buckets = loadCommissionBucketsLocal(db, rep.id, nextPayoutStr, currentMonthStr, nextMonthStr);
        return {
          ...rep,
          commissionEarned: buckets.settled,
          commissionPending: buckets.pending,
          totalCommission: Number((buckets.settled + buckets.pending).toFixed(2)),
        };
      });

      return apiSuccess(
        repStats.sort((a, b) => b.totalCommission - a.totalCommission).slice(0, limit)
      );
    }

    const supabase = await createClient();
    const repsQuery = (supabase as any).from('bdr_reps').select('id, name, email, status');
    const repsResult = await repsQuery;
    const { data: reps, error: repsError } = repsResult as { data: any[] | null; error: any };

    if (repsError) {
      return apiError(repsError.message, 500);
    }

    const { loadCommissionBucketsSupabase } = await import('@/lib/dashboard/dashboard-metrics');
    const repStats = await Promise.all(
      (reps || []).map(async (rep: any) => {
        const buckets = await loadCommissionBucketsSupabase(
          supabase,
          rep.id,
          nextPayoutStr,
          currentMonthStr,
          nextMonthStr
        );
        return {
          ...rep,
          commissionEarned: buckets.settled,
          commissionPending: buckets.pending,
          totalCommission: Number((buckets.settled + buckets.pending).toFixed(2)),
        };
      })
    );

    return apiSuccess(
      repStats.sort((a, b) => b.totalCommission - a.totalCommission).slice(0, limit)
    );
  } catch (error: any) {
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}
