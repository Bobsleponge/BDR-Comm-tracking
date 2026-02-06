import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;
    const supabase = await createClient();

    const query = (supabase as any)
      .from('deals')
      .select('*, deal_services(*)')
      .eq('client_id', id)
      .order('created_at', { ascending: false });
    const queryResult = await query;
    const { data, error } = queryResult as { data: any[] | null; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}


