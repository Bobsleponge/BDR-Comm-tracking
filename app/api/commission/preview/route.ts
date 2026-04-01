import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { calculateCommissionPreview } from '@/lib/commission/preview';
import type { PreviewDeal, PreviewService } from '@/lib/commission/preview';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * POST /api/commission/preview
 * Preview commission for a hypothetical deal. No DB writes.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuth();

    const body = await request.json();
    const deal = body.deal as PreviewDeal;
    const services = body.services as PreviewService[];

    if (!deal || !services || !Array.isArray(services)) {
      return apiError('deal and services (array) required', 400);
    }
    if (!deal.close_date) {
      return apiError('deal.close_date required', 400);
    }
    if (services.length === 0) {
      return apiError('At least one service required', 400);
    }

    let baseRate = 0.025;
    let payoutDelayDays = 30;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const rules = db.prepare('SELECT base_rate, payout_delay_days FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as { base_rate?: number; payout_delay_days?: number } | undefined;
      baseRate = rules?.base_rate ?? 0.025;
      payoutDelayDays = rules?.payout_delay_days ?? 30;
    } else {
      const supabase = await createClient();
      const { data: rules } = await (supabase as any)
        .from('commission_rules')
        .select('base_rate, payout_delay_days')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
      baseRate = rules?.base_rate ?? 0.025;
      payoutDelayDays = rules?.payout_delay_days ?? 30;
    }

    const result = calculateCommissionPreview(deal, services, baseRate, payoutDelayDays);
    return apiSuccess(result, 200, { cache: 'no-store' });
  } catch (error: any) {
    return apiError(error.message || 'Preview failed', 400);
  }
}
