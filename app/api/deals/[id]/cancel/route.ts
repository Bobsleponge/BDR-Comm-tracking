import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { cancelFutureCommissionEntries } from '@/lib/commission/scheduler';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const { cancellation_date } = body;

    if (!cancellation_date) {
      return apiError('Cancellation date is required', 400);
    }

    if (USE_LOCAL_DB) {
      // Local DB mode
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Get existing deal
      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      if (!deal) {
        return apiError('Deal not found', 404);
      }

      // Check access
      if (!(await canAccessBdr(deal.bdr_id))) {
        return apiError('Forbidden', 403);
      }

      const cancellationDate = new Date(cancellation_date);

      // Update deal
      db.prepare("UPDATE deals SET cancellation_date = ?, updated_at = datetime('now') WHERE id = ?").run(cancellation_date, id);

      // Cancel future commission entries
      try {
        await cancelFutureCommissionEntries(id, cancellationDate);
      } catch (err) {
        console.error('Error cancelling commission entries:', err);
      }

      // Fetch updated deal
      const updatedDeal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      return apiSuccess(updatedDeal);
    }

    // Supabase mode
    const supabase = await createClient();

    // Get existing deal
    const fetchQuery = (supabase as any)
      .from('deals')
      .select('*')
      .eq('id', id)
      .single();
    const fetchResult = await fetchQuery;
    const { data: deal, error: fetchError } = fetchResult as { data: any; error: any };

    if (fetchError || !deal) {
      return apiError('Deal not found', 404);
    }

    // Check access
    if (!(await canAccessBdr(deal.bdr_id))) {
      return apiError('Forbidden', 403);
    }

    const cancellationDate = new Date(cancellation_date);

    // Update deal
    const updateResult = await (supabase
      .from('deals')
      .update({ cancellation_date: cancellation_date })
      .eq('id', id)
      .select()
      .single() as any);
    const { data: updatedDeal, error: updateError } = updateResult as { data: any; error: any };

    if (updateError) {
      return apiError(updateError.message, 500);
    }

    // Cancel future commission entries
    try {
      await cancelFutureCommissionEntries(id, cancellationDate);
    } catch (err) {
      console.error('Error cancelling commission entries:', err);
    }

    return apiSuccess(updatedDeal);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}



