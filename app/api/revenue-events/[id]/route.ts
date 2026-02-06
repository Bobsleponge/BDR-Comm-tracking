import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { processRevenueEvent } from '@/lib/commission/revenue-events';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    await requireAdmin();

    const { id } = await params;
    const body = await request.json();
    const { amount_collected, collection_date, commissionable } = body;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const updates: string[] = [];
      const params: any[] = [];

      if (amount_collected !== undefined) {
        updates.push('amount_collected = ?');
        params.push(amount_collected);
      }

      if (collection_date !== undefined) {
        updates.push('collection_date = ?');
        params.push(collection_date);
      }

      if (commissionable !== undefined) {
        updates.push('commissionable = ?');
        params.push(commissionable ? 1 : 0);
      }

      if (updates.length === 0) {
        return apiError('No fields to update', 400);
      }

      updates.push("updated_at = datetime('now')");
      params.push(id);

      db.prepare(`
        UPDATE revenue_events 
        SET ${updates.join(', ')}
        WHERE id = ?
      `).run(...params);

      return apiSuccess({ id });
    }

    // Supabase mode
    const supabase = await createClient();

    const updateData: any = {};
    if (amount_collected !== undefined) updateData.amount_collected = amount_collected;
    if (collection_date !== undefined) updateData.collection_date = collection_date;
    if (commissionable !== undefined) updateData.commissionable = commissionable;

    if (Object.keys(updateData).length === 0) {
      return apiError('No fields to update', 400);
    }

    const { data, error } = await (supabase
      .from('revenue_events')
      .update(updateData)
      .eq('id', id)
      .select('id')
      .single() as any);

    if (error) {
      return apiError(error.message || 'Failed to update revenue event', 500);
    }

    return apiSuccess(data);
  } catch (error: any) {
    return apiError(error.message || 'Failed to update revenue event', 500);
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

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Check if revenue event exists
      const event = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(id) as any;
      if (!event) {
        return apiError('Revenue event not found', 404);
      }

      // Delete associated commission entries first
      db.prepare('DELETE FROM commission_entries WHERE revenue_event_id = ?').run(id);

      // Delete revenue event
      db.prepare('DELETE FROM revenue_events WHERE id = ?').run(id);

      return apiSuccess({ id });
    }

    // Supabase mode
    const supabase = await createClient();

    // Delete associated commission entries first
    await (supabase
      .from('commission_entries')
      .delete()
      .eq('revenue_event_id', id) as any);

    // Delete revenue event
    const { error } = await (supabase
      .from('revenue_events')
      .delete()
      .eq('id', id) as any);

    if (error) {
      return apiError(error.message || 'Failed to delete revenue event', 500);
    }

    return apiSuccess({ id });
  } catch (error: any) {
    return apiError(error.message || 'Failed to delete revenue event', 500);
  }
}

