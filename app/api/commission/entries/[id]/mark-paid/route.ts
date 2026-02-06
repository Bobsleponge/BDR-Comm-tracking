import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    await requireAdmin();
    const { id } = await params;

    if (USE_LOCAL_DB) {
      // Local DB mode
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Check if entry exists
      const entry = db.prepare('SELECT * FROM commission_entries WHERE id = ?').get(id) as any;
      if (!entry) {
        return apiError('Commission entry not found', 404);
      }

      // Update status
      db.prepare("UPDATE commission_entries SET status = ?, updated_at = datetime('now') WHERE id = ?").run('paid', id);

      // Fetch updated entry
      const updatedEntry = db.prepare('SELECT * FROM commission_entries WHERE id = ?').get(id) as any;

      return apiSuccess(updatedEntry);
    }

    // Supabase mode
    const supabase = await createClient();

    const result = await (supabase
      .from('commission_entries')
      .update({ status: 'paid' })
      .eq('id', id)
      .select()
      .single() as any);
    const { data, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data);
  } catch (error: any) {
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}



