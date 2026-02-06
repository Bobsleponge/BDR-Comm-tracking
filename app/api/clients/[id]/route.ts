import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { z } from 'zod';

const clientSchema = z.object({
  name: z.string().min(1, 'Client name is required').optional(),
  company: z.string().optional().nullable(),
  email: z.string().email('Invalid email address').optional().nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;
    const supabase = await createClient();

    const query = (supabase as any)
      .from('clients')
      .select('*')
      .eq('id', id)
      .single();
    const { data, error } = (await query) as { data: any; error: any };

    if (error) {
      return apiError(error.message, 404);
    }

    return apiSuccess(data);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;
    const supabase = await createClient();
    const body = await request.json();

    const validated = clientSchema.partial().parse(body);

    const result = await (supabase
      .from('clients')
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
    return apiError(error.message, 401);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { requireAdmin } = await import('@/lib/utils/api-helpers');
    await requireAdmin();
    const { id } = await params;

    const supabase = await createClient();
    const result = await (supabase
      .from('clients')
      .delete()
      .eq('id', id) as any);
    const { error } = result as { error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess({ success: true });
  } catch (error: any) {
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}


