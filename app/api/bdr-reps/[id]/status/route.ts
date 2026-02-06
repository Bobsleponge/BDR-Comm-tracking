import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { handleRepLeave } from '@/lib/commission/scheduler';

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
    const { status, do_not_pay_future } = body;

    const updates: any = {};
    if (status) {
      updates.status = status;
    }
    if (do_not_pay_future !== undefined) {
      updates.do_not_pay_future = do_not_pay_future;
    }

    const result = await (supabase
      .from('bdr_reps')
      .update(updates)
      .eq('id', id)
      .select()
      .single() as any);
    const { data, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    // If do_not_pay_future is true, handle rep leave
    if (do_not_pay_future) {
      try {
        await handleRepLeave(id);
      } catch (err) {
        console.error('Error handling rep leave:', err);
      }
    }

    return apiSuccess(data);
  } catch (error: any) {
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}



