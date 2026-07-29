import { NextRequest } from 'next/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { safeReprocessDeal } from '@/lib/commission/safe-reprocess';

/**
 * POST /api/deals/safe-reprocess
 * Rebuild commission for a deal while preserving approved/fingerprinted months.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    const body = await request.json();
    const { dealId } = body;

    if (!dealId) {
      return apiError('Deal ID is required', 400);
    }

    const result = await safeReprocessDeal(dealId);
    return apiSuccess({
      message: 'Deal safely reprocessed',
      ...result,
    });
  } catch (error: any) {
    return apiError(error.message || 'Safe reprocess failed', 500);
  }
}
