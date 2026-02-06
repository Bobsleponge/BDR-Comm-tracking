import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { quarterlyTargetSchema } from '@/lib/commission/validators';

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
      .from('quarterly_targets')
      .select('*, bdr_reps(name, email)')
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

    const validated = quarterlyTargetSchema.parse(body);

    const query = (supabase as any)
      .from('quarterly_targets')
      .upsert(validated, {
        onConflict: 'bdr_id,quarter',
      })
      .select()
      .single();
    const result = await query;
    const { data, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data, 201);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return apiError(`Validation error: ${error.errors.map((e: any) => e.message).join(', ')}`, 400);
    }
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}




