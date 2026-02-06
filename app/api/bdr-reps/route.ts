import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { bdrRepSchema } from '@/lib/commission/validators';

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const supabase = await createClient();
    const { isAdmin, getCurrentUser, getBdrIdFromUser } = await import('@/lib/utils/auth');

    const isUserAdmin = await isAdmin();

    if (isUserAdmin) {
      // Admin can see all reps
      const query = (supabase as any)
        .from('bdr_reps')
        .select('*')
        .order('name');
      const { data, error } = await query;

      if (error) {
        return apiError(error.message, 500);
      }

      // Ensure data is always an array for admin requests
      const repsArray = Array.isArray(data) ? data : (data ? [data] : []);
      return apiSuccess(repsArray);
    } else {
      // BDR can only see their own profile
      const user = await getCurrentUser();
      if (!user?.email) {
        return apiError('User not found', 404);
      }

      const query = (supabase as any)
        .from('bdr_reps')
        .select('*')
        .eq('email', user.email)
        .single();
      const { data, error } = (await query) as { data: any; error: any };

      if (error) {
        return apiError(error.message, 404);
      }

      // Ensure data is always an array (wrap single object in array for BDR requests)
      const repsArray = Array.isArray(data) ? data : (data ? [data] : []);
      return apiSuccess(repsArray);
    }
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

    const validated = bdrRepSchema.parse(body);

    const result = await (supabase
      .from('bdr_reps')
      .insert(validated)
      .select()
      .single() as any);
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



