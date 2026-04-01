import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { canAccessBdr } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * PATCH /api/commission/entries/[id]
 * Update commission entry amount. Used for percentage_of_net_sales placeholder entries.
 * Body: { amount?: number, net_sales?: number }
 * - If net_sales provided: compute amount = net_sales * billing_percentage * base_rate
 * - If amount provided: save directly (manual override)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;
    const body = await request.json();
    const { amount: directAmount, net_sales } = body;

    if (directAmount != null && (typeof directAmount !== 'number' || directAmount < 0)) {
      return apiError('Invalid amount', 400);
    }
    if (net_sales != null && (typeof net_sales !== 'number' || net_sales < 0)) {
      return apiError('Invalid net_sales', 400);
    }
    if (directAmount == null && net_sales == null) {
      return apiError('Provide either amount or net_sales', 400);
    }

    let amountToSave: number;
    if (directAmount != null) {
      amountToSave = Number(directAmount.toFixed(2));
    } else {
      // Compute from net_sales: amount = net_sales * billing_percentage * base_rate
      if (USE_LOCAL_DB) {
        const { getLocalDB } = await import('@/lib/db/local-db');
        const db = getLocalDB();
        const entry = db.prepare('SELECT * FROM commission_entries WHERE id = ?').get(id) as any;
        if (!entry) return apiError('Commission entry not found', 404);
        if (!(await canAccessBdr(entry.bdr_id))) return apiError('Forbidden', 403);
        // Only allow for placeholder entries (revenue_event_id IS NULL) linked to a service
        if (entry.revenue_event_id) return apiError('Cannot update amount for auto-calculated entries; use override in batch', 400);
        const service = entry.service_id ? db.prepare('SELECT billing_percentage FROM deal_services WHERE id = ?').get(entry.service_id) as any : null;
        const billingPct = service?.billing_percentage;
        if (billingPct == null || billingPct <= 0) return apiError('Service billing percentage not configured', 400);
        const rules = db.prepare('SELECT base_rate FROM commission_rules LIMIT 1').get() as any;
        const baseRate = rules?.base_rate ?? 0.025;
        amountToSave = Number((net_sales * billingPct * baseRate).toFixed(2));
      } else {
        const supabase = await createClient() as any;
        const { data: entry } = await supabase.from('commission_entries').select('*').eq('id', id).single();
        if (!entry) return apiError('Commission entry not found', 404);
        if (!(await canAccessBdr(entry.bdr_id))) return apiError('Forbidden', 403);
        if (entry.revenue_event_id) return apiError('Cannot update amount for auto-calculated entries; use override in batch', 400);
        const { data: service } = entry.service_id
          ? await supabase.from('deal_services').select('billing_percentage').eq('id', entry.service_id).single()
          : { data: null };
        const billingPct = service?.billing_percentage;
        if (billingPct == null || billingPct <= 0) return apiError('Service billing percentage not configured', 400);
        const { data: rules } = await supabase.from('commission_rules').select('base_rate').order('updated_at', { ascending: false }).limit(1).single();
        const baseRate = rules?.base_rate ?? 0.025;
        amountToSave = Number((net_sales * billingPct * baseRate).toFixed(2));
      }
    }

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const entry = db.prepare('SELECT * FROM commission_entries WHERE id = ?').get(id) as any;
      if (!entry) return apiError('Commission entry not found', 404);
      if (!(await canAccessBdr(entry.bdr_id))) return apiError('Forbidden', 403);
      db.prepare("UPDATE commission_entries SET amount = ?, updated_at = datetime('now') WHERE id = ?").run(amountToSave, id);
      const updated = db.prepare('SELECT * FROM commission_entries WHERE id = ?').get(id) as any;
      return apiSuccess(updated);
    }

    const supabase = await createClient() as any;
    const { data: entry } = await supabase.from('commission_entries').select('bdr_id, revenue_event_id').eq('id', id).single();
    if (!entry) return apiError('Commission entry not found', 404);
    if (!(await canAccessBdr(entry.bdr_id))) return apiError('Forbidden', 403);
    const { data: updated, error } = await supabase.from('commission_entries').update({ amount: amountToSave }).eq('id', id).select().single();
    if (error) return apiError(error.message, 500);
    return apiSuccess(updated);
  } catch (error: any) {
    return apiError(error.message || 'Unauthorized', 401);
  }
}
