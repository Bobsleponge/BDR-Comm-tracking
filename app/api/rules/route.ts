import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { commissionRulesSchema } from '@/lib/commission/validators';

export async function GET() {
  try {
    await requireAuth();
    const supabase = await createClient();

    const query = (supabase as any)
      .from('commission_rules')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    const result = await query;
    const { data, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    const supabase = await createClient();
    const body = await request.json();

    const validated = commissionRulesSchema.partial().parse(body);

    // Get current user for updated_by
    const { getCurrentUser } = await import('@/lib/utils/auth');
    const user = await getCurrentUser();

      const existingQuery = (supabase as any)
        .from('commission_rules')
        .select('id')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
      const existingResult = await existingQuery;
    const { data: existing } = existingResult as { data: any; error: any };

    let result;
    if (existing) {
      // Update existing
      const updateResult = await (supabase
        .from('commission_rules')
        .update({
          ...validated,
          updated_by: user?.id ?? null,
        })
        .eq('id', existing.id)
        .select()
        .single() as any);
      const { data, error } = updateResult as { data: any; error: any };

      if (error) {
        return apiError(error.message, 500);
      }
      result = data;
    } else {
      // Create new
      const insertResult = await (supabase
        .from('commission_rules')
        .insert({
          ...validated,
          updated_by: user?.id ?? null,
        })
        .select()
        .single() as any);
      const { data, error } = insertResult as { data: any; error: any };

      if (error) {
        return apiError(error.message, 500);
      }
      result = data;
    }

    return apiSuccess(result);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return apiError(`Validation error: ${error.errors.map((e: any) => e.message).join(', ')}`, 400);
    }
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}




