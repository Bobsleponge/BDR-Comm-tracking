import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { loadDashboardStatsForBdr } from '@/lib/dashboard/dashboard-metrics';

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
    } else if (!targetBdrId) {
      const userBdrId = await getBdrIdFromUser();
      if (userBdrId) {
        targetBdrId = userBdrId;
      }
    }

    if (!targetBdrId) {
      return apiError('BDR ID is required', 400);
    }

    const stats = USE_LOCAL_DB
      ? loadDashboardStatsForBdr(targetBdrId)
      : await loadDashboardStatsForBdr(targetBdrId, { supabase: await createClient() });

    return apiSuccess(stats, 200, { cache: 'no-store' });
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}
