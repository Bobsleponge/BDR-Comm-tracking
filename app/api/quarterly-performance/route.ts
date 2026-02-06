import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { quarterlyPerformanceSchema } from '@/lib/commission/validators';
import { calculateQuarterlyBonus } from '@/lib/commission/calculator';

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const supabase = await createClient();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');
    const quarter = searchParams.get('quarter');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    let query: any = ((supabase as any)
      .from('quarterly_performance')
      .select('*, bdr_reps(name, email), quarterly_targets(target_revenue)')
      .order('quarter', { ascending: false }));

    if (!isUserAdmin && bdrId) {
      const userBdrId = await getBdrIdFromUser();
      if (userBdrId !== bdrId) {
        return apiError('Forbidden', 403);
      }
    }

    if (bdrId) {
      query = query.eq('bdr_id', bdrId);
    }

    if (quarter) {
      query = query.eq('quarter', quarter);
    }

    const { data, error } = (await query) as { data: any[] | null; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    const supabase = await createClient();
    const body = await request.json();

    const validated = quarterlyPerformanceSchema.parse(body);

    // Get quarterly target
    const targetQuery = (supabase as any)
      .from('quarterly_targets')
      .select('target_revenue')
      .eq('bdr_id', validated.bdr_id)
      .eq('quarter', validated.quarter)
      .single();
    const targetResult = await targetQuery;
    const { data: target, error: targetError } = targetResult as { data: any; error: any };

    if (targetError || !target) {
      return apiError('Quarterly target not found', 404);
    }

    // Calculate revenue from revenue_events if not manually provided
    let revenueCollected = validated.revenue_collected;
    
    // Parse quarter to get date range
    const { parseQuarter } = await import('@/lib/commission/calculator');
    const { start, end } = parseQuarter(validated.quarter);
    const quarterStartStr = start.toISOString().split('T')[0];
    const quarterEndStr = end.toISOString().split('T')[0];

    // Get revenue from revenue_events
    const revenueEventsQuery = (supabase as any)
      .from('revenue_events')
      .select('amount_collected')
      .eq('bdr_id', validated.bdr_id)
      .gte('collection_date', quarterStartStr)
      .lte('collection_date', quarterEndStr)
      .eq('commissionable', true);
    
    const { data: revenueEvents } = (await revenueEventsQuery) as { data: any[] | null };
    const calculatedRevenue = (revenueEvents || []).reduce(
      (sum: number, e: any) => sum + Number(e.amount_collected || 0),
      0
    );

    // Use calculated revenue if manual revenue not provided or is 0
    if (!revenueCollected || revenueCollected === 0) {
      revenueCollected = calculatedRevenue;
    }

    // Get commission rules
    const rulesQuery = (supabase as any)
      .from('commission_rules')
      .select('quarterly_bonus_rate')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    const rulesResult = await rulesQuery;
    const { data: rules, error: rulesError } = rulesResult as { data: any; error: any };

    if (rulesError || !rules) {
      return apiError('Commission rules not found', 404);
    }

    // Calculate bonus eligibility
    const { eligible, bonusAmount } = calculateQuarterlyBonus(
      revenueCollected,
      target.target_revenue,
      rules.quarterly_bonus_rate
    );

    const achievedPercent = target.target_revenue > 0
      ? (revenueCollected / target.target_revenue) * 100
      : 0;

    const upsertResult = await (supabase
      .from('quarterly_performance')
      .upsert({
        ...validated,
        revenue_collected: revenueCollected,
        achieved_percent: Number(achievedPercent.toFixed(2)),
        bonus_eligible: eligible,
      }, {
        onConflict: 'bdr_id,quarter',
      })
      .select()
      .single() as any);
    const { data, error } = upsertResult as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess({ ...data, bonusAmount }, 201);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return apiError(`Validation error: ${error.errors.map((e: any) => e.message).join(', ')}`, 400);
    }
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}




