import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { bdrRepSchema } from '@/lib/commission/validators';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    await requireAdmin();
    const { id } = await params;

    const supabase = await createClient();
    const body = await request.json();

    const validated = bdrRepSchema.partial().parse(body);

    const result = await (supabase
      .from('bdr_reps')
      .update(validated)
      .eq('id', id)
      .select()
      .single() as any);
    const { data, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return apiError(`Validation error: ${error.errors.map((e: any) => e.message).join(', ')}`, 400);
    }
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    await requireAdmin();
    const { id } = await params;

    const supabase = await createClient();

    // Check if this is the current user (prevent self-deletion)
    const { getCurrentUser } = await import('@/lib/utils/auth');
    const currentUser = await getCurrentUser();
    if (currentUser?.email) {
      const query = (supabase as any)
        .from('bdr_reps')
        .select('email')
        .eq('id', id)
        .single();
      const result = await query as { data: { email: string } | null; error: any };
      
      if (result.data && result.data.email === currentUser.email) {
        return apiError('Cannot delete your own account', 400);
      }
    }

    const deleteResult = await (supabase
      .from('bdr_reps')
      .delete()
      .eq('id', id) as any);
    const { error } = deleteResult as { error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess({ success: true });
  } catch (error: any) {
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}



