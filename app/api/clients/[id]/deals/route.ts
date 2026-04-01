import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const deals = db.prepare(`
        SELECT deals.*, clients.name as client_name_from_client, clients.company
        FROM deals
        LEFT JOIN clients ON deals.client_id = clients.id
        WHERE deals.client_id = ?
        ORDER BY deals.created_at DESC
      `).all(id) as any[];

      const overrideDealIds = new Set(
        (db.prepare(`
          SELECT DISTINCT ce.deal_id
          FROM commission_entries ce
          JOIN commission_batch_items cbi ON cbi.commission_entry_id = ce.id
          WHERE cbi.override_amount IS NOT NULL
             OR cbi.override_payment_date IS NOT NULL
             OR cbi.override_commission_rate IS NOT NULL
        `).all() as Array<{ deal_id: string }>).map((r) => r.deal_id)
      );

      for (const deal of deals) {
        const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(deal.id) as any[];
        deal.deal_services = services;
        deal.has_override = overrideDealIds.has(deal.id);
      }

      return apiSuccess(deals);
    }

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

    const dealsData = data || [];
    const dealIds = dealsData.map((d: any) => d.id).filter(Boolean);

    const overrideDealIds = new Set<string>();
    if (dealIds.length > 0) {
      const { data: entries } = await (supabase as any)
        .from('commission_entries')
        .select('id, deal_id')
        .in('deal_id', dealIds);
      const entryIds = (entries || []).map((e: any) => e.id);
      const entryToDeal = new Map((entries || []).map((e: any) => [e.id, e.deal_id]));
      if (entryIds.length > 0) {
        const { data: batchItems } = await (supabase as any)
          .from('commission_batch_items')
          .select('commission_entry_id')
          .in('commission_entry_id', entryIds)
          .or('override_amount.not.is.null,override_payment_date.not.is.null,override_commission_rate.not.is.null');
        for (const item of batchItems || []) {
          const dealId = entryToDeal.get(item.commission_entry_id);
          if (typeof dealId === 'string') overrideDealIds.add(dealId);
        }
      }
    }
    for (const deal of dealsData) {
      deal.has_override = overrideDealIds.has(deal.id);
    }

    return apiSuccess(dealsData);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}


