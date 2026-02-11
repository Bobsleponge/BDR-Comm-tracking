import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { handleRepLeave } from '@/lib/commission/scheduler';
import { bdrRepStatusSchema } from '@/lib/commission/validators';

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
    
    // Validate input
    const validationResult = bdrRepStatusSchema.safeParse(body);
    if (!validationResult.success) {
      return apiError(
        `Validation error: ${validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        400
      );
    }
    
    const { status, do_not_pay_future, leave_date, allow_trailing_commission } = validationResult.data;

    const updates: any = {};
    if (status) {
      updates.status = status;
    }
    if (allow_trailing_commission !== undefined) {
      updates.allow_trailing_commission = allow_trailing_commission;
    }
    if (do_not_pay_future !== undefined) {
      // Map to allow_trailing_commission: do_not_pay_future means no trailing commission
      updates.allow_trailing_commission = !do_not_pay_future;
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
        const leaveDate = new Date(); // Use current date as leave date
        await handleRepLeave(id, leaveDate);
      } catch (err) {
        console.error('Error handling rep leave:', err);
      }
    }

    return apiSuccess(data);
  } catch (error: any) {
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}



