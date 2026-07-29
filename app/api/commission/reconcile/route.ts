import { NextRequest } from 'next/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { reconcileDeal } from '@/lib/commission/reconcile-deal';

/**
 * GET /api/commission/reconcile?deal_id=
 * Compare approved fingerprint amounts vs live commission entries per month.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth();

    const { searchParams } = new URL(request.url);
    const dealId = searchParams.get('deal_id');

    if (!dealId) {
      return apiError('deal_id is required', 400);
    }

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }

      const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (USE_LOCAL_DB) {
        const { getLocalDB } = await import('@/lib/db/local-db');
        const db = getLocalDB();
        const deal = db.prepare('SELECT bdr_id FROM deals WHERE id = ?').get(dealId) as { bdr_id: string } | undefined;
        if (!deal || deal.bdr_id !== userBdrId) {
          return apiError('Forbidden', 403);
        }
      }
    }

    const result = await reconcileDeal(dealId);
    if (!result) {
      return apiError('Deal not found', 404);
    }

    return apiSuccess(result, 200, { cache: 'no-store' });
  } catch (error: any) {
    return apiError(error.message || 'Reconcile failed', 500);
  }
}
