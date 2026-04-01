import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { parseISO, addDays, format } from 'date-fns';
import { dealUpdateSchema } from '@/lib/commission/validators';

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

      const deal = db.prepare(`
        SELECT deals.*, 
               clients.name as client_name_from_client,
               clients.company,
               clients.email as client_email
        FROM deals
        LEFT JOIN clients ON deals.client_id = clients.id
        WHERE deals.id = ?
      `).get(id) as any;

      if (!deal) {
        return apiError('Deal not found', 404);
      }

      // Check access
      if (!(await canAccessBdr(deal.bdr_id))) {
        return apiError('Forbidden', 403);
      }

      // Get deal services
      const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(id) as any[];
      deal.deal_services = services;

      // Check if deal has commission batch overrides
      const hasOverride = db.prepare(`
        SELECT 1 FROM commission_entries ce
        JOIN commission_batch_items cbi ON cbi.commission_entry_id = ce.id
        WHERE ce.deal_id = ?
          AND (cbi.override_amount IS NOT NULL
               OR cbi.override_payment_date IS NOT NULL
               OR cbi.override_commission_rate IS NOT NULL)
        LIMIT 1
      `).get(id);
      deal.has_override = !!hasOverride;

      return apiSuccess(deal, 200, { cache: 'no-store' });
    }

    const supabase = await createClient();
    const query = (supabase as any)
      .from('deals')
      .select('*, deal_services(*), clients(*)')
      .eq('id', id)
      .single();
    const { data, error } = (await query) as { data: any; error: any };

    if (error) {
      return apiError(error.message, 404);
    }

    // Check access
    if (!(await canAccessBdr(data.bdr_id))) {
      return apiError('Forbidden', 403);
    }

    // Check if deal has commission batch overrides (Supabase)
    const { data: entries } = await (supabase as any)
      .from('commission_entries')
      .select('id')
      .eq('deal_id', id);
    const entryIds = (entries || []).map((e: any) => e.id);
    let hasOverride = false;
    if (entryIds.length > 0) {
      const { data: batchItems } = await (supabase as any)
        .from('commission_batch_items')
        .select('commission_entry_id')
        .in('commission_entry_id', entryIds)
        .or('override_amount.not.is.null,override_payment_date.not.is.null,override_commission_rate.not.is.null');
      hasOverride = (batchItems || []).length > 0;
    }
    data.has_override = hasOverride;

    return apiSuccess(data, 200, { cache: 'no-store' });
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
    const body = await request.json();
    
    // Validate input
    const validationResult = dealUpdateSchema.safeParse(body);
    if (!validationResult.success) {
      return apiError(
        `Validation error: ${validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        400
      );
    }

    // All deals must remain associated to a client - reject clearing client_id
    if ('client_id' in body) {
      if (body.client_id === null || body.client_id === '') {
        return apiError('Client is required. Deals cannot be unlinked from a client.', 400);
      }
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (typeof body.client_id !== 'string' || !uuidRegex.test(body.client_id)) {
        return apiError('Invalid client ID. Please select a valid client.', 400);
      }
    }

    if (USE_LOCAL_DB) {
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

      // Use validated data to avoid FK violations (empty string -> null for client_id, original_deal_id, etc.)
      const data = validationResult.data;

      // Update deal
      const updateFields: string[] = [];
      const updateValues: any[] = [];

      const allowedFields = ['client_name', 'service_type', 'proposal_date', 'close_date', 
                            'first_invoice_date', 'deal_value', 'status', 'is_renewal', 
                            'payout_months', 'client_id', 'bdr_id', 'cancellation_date', 
                            'do_not_pay_future', 'original_deal_value', 'original_deal_id'];
      
      // Auto-calculate first_invoice_date if close_date is being updated
      // For paid_on_completion deals: first_invoice_date = completion_date (managed by service), do not overwrite
      let firstInvoiceDate = data.first_invoice_date ?? body.first_invoice_date;
      const hasPaidOnCompletion = db.prepare(
        'SELECT 1 FROM deal_services WHERE deal_id = ? AND billing_type = ? AND completion_date IS NOT NULL LIMIT 1'
      ).get(id, 'paid_on_completion');
      if (!hasPaidOnCompletion && (data.close_date !== undefined || body.close_date !== undefined) && !firstInvoiceDate) {
        const baseDate = (data.close_date ?? body.close_date) || deal.proposal_date;
        if (baseDate) {
          const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
          const calculatedDate = addDays(baseDateObj, 7);
          firstInvoiceDate = format(calculatedDate, 'yyyy-MM-dd');
        }
      } else if (!hasPaidOnCompletion && (data.proposal_date !== undefined || body.proposal_date !== undefined) && !data.close_date && !body.close_date && !firstInvoiceDate && !deal.close_date) {
        const baseDate = data.proposal_date ?? body.proposal_date;
        if (baseDate) {
          const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
          const calculatedDate = addDays(baseDateObj, 7);
          firstInvoiceDate = format(calculatedDate, 'yyyy-MM-dd');
        }
      }
      
      const sqliteValue = (v: any, key: string) => {
        if (v === undefined) return undefined;
        if (key === 'is_renewal' || key === 'do_not_pay_future') return v ? 1 : 0;
        // FK fields: empty string or invalid -> null to avoid constraint failure
        if (key === 'client_id' || key === 'bdr_id' || key === 'original_deal_id') {
          if (v === '' || v === null) return null;
          if (key === 'original_deal_id' && v === id) return null; // no self-reference
          if (typeof v === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return null;
        }
        return v;
      };
      for (const key of allowedFields) {
        const value = (data as Record<string, unknown>)[key] ?? (body as Record<string, unknown>)[key];
        const v = sqliteValue(value, key);
        if (v !== undefined) {
          updateFields.push(`${key} = ?`);
          updateValues.push(v);
        }
      }

      // Add first_invoice_date if it was calculated
      if (firstInvoiceDate) {
        updateFields.push('first_invoice_date = ?');
        updateValues.push(firstInvoiceDate);
      }

      if (updateFields.length === 0) {
        return apiError('No valid fields to update', 400);
      }

      updateFields.push("updated_at = datetime('now')");
      updateValues.push(id);

      const updateQuery = `UPDATE deals SET ${updateFields.join(', ')} WHERE id = ?`;
      db.transaction(() => {
        db.prepare(updateQuery).run(...updateValues);

        // If services array is provided, recalculate deal_value from services
        if (body.services && Array.isArray(body.services)) {
          const services = db.prepare('SELECT commissionable_value FROM deal_services WHERE deal_id = ?').all(id) as any[];
          const totalValue = services.reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
          db.prepare('UPDATE deals SET deal_value = ? WHERE id = ?').run(totalValue, id);
        }

        // Reprocess deal: remove all commission entries and revenue events, recreate as if new deal
        const services = db.prepare('SELECT id FROM deal_services WHERE deal_id = ?').all(id) as any[];
        if (services.length > 0) {
          db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(id);
          db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(id);
        }
      })();

      // Recreate revenue events and commission entries (async, outside transaction)
      const services = db.prepare('SELECT id FROM deal_services WHERE deal_id = ?').all(id) as any[];
      if (services.length > 0) {
        const { createRevenueEventsForDeal, processRevenueEvent } = await import('@/lib/commission/revenue-events');
        await createRevenueEventsForDeal(id);
        const revenueEvents = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ?').all(id) as Array<{ id: string }>;
        for (const ev of revenueEvents) {
          try {
            await processRevenueEvent(ev.id);
          } catch {
            // Ignore individual processing errors
          }
        }
      }

      // Fetch updated deal with services
      const updatedDeal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      const dealServices = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(id) as any[];
      updatedDeal.deal_services = dealServices;
      return apiSuccess(updatedDeal);
    }

    const supabase = await createClient();
    
    // Get existing deal
    const fetchQuery = (supabase as any)
      .from('deals')
      .select('*')
      .eq('id', id)
      .single();
    const fetchResult = await fetchQuery;
    const { data: existingDeal, error: fetchError } = fetchResult as { data: any; error: any };

    if (fetchError) {
      return apiError('Deal not found', 404);
    }

    // Check access
    if (!(await canAccessBdr(existingDeal.bdr_id))) {
      return apiError('Forbidden', 403);
    }

    // Auto-calculate first_invoice_date if close_date is being updated
    // For paid_on_completion deals: first_invoice_date = completion_date (managed by service), do not overwrite
    const updateBody = { ...body };
    const { data: pocCheck } = await (supabase as any)
      .from('deal_services')
      .select('id')
      .eq('deal_id', id)
      .eq('billing_type', 'paid_on_completion')
      .not('completion_date', 'is', null)
      .limit(1);
    const hasPaidOnCompletion = pocCheck && pocCheck.length > 0;
    if (!hasPaidOnCompletion && body.close_date !== undefined && !body.first_invoice_date) {
      const baseDate = body.close_date || existingDeal.proposal_date;
      if (baseDate) {
        const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
        const calculatedDate = addDays(baseDateObj, 7);
        updateBody.first_invoice_date = format(calculatedDate, 'yyyy-MM-dd');
      }
    } else if (!hasPaidOnCompletion && body.proposal_date !== undefined && !body.close_date && !body.first_invoice_date && !existingDeal.close_date) {
      const baseDate = body.proposal_date;
      if (baseDate) {
        const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
        const calculatedDate = addDays(baseDateObj, 7);
        updateBody.first_invoice_date = format(calculatedDate, 'yyyy-MM-dd');
      }
    }

    // If services array is provided, recalculate deal_value from services
    if (body.services && Array.isArray(body.services)) {
      const { data: services } = await (supabase as any)
        .from('deal_services')
        .select('commissionable_value')
        .eq('deal_id', id);
      const totalValue = services?.reduce((sum: number, s: any) => sum + (s.commissionable_value || 0), 0) || 0;
      updateBody.deal_value = totalValue;
    }

    const result = await (supabase
      .from('deals')
      .update(updateBody)
      .eq('id', id)
      .select()
      .single() as any);
    const { data, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    // Reprocess deal: remove all commission entries and revenue events, recreate as if new deal
    const { data: dealServices } = await (supabase as any)
      .from('deal_services')
      .select('id')
      .eq('deal_id', id);
    if (dealServices && dealServices.length > 0) {
      const { createRevenueEventsForDeal, processRevenueEvent } = await import('@/lib/commission/revenue-events');
      await (supabase as any).from('commission_entries').delete().eq('deal_id', id);
      await (supabase as any).from('revenue_events').delete().eq('deal_id', id);
      await createRevenueEventsForDeal(id);
      const eventsResult = await (supabase as any).from('revenue_events').select('id').eq('deal_id', id);
      const revenueEvents = eventsResult.data || [];
      for (const ev of revenueEvents) {
        try {
          await processRevenueEvent(ev.id);
        } catch {
          // Ignore individual processing errors
        }
      }
    }

    // Fetch services
    const { data: services } = await (supabase as any)
      .from('deal_services')
      .select('*')
      .eq('deal_id', id);
    data.deal_services = services || [];

    return apiSuccess(data);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      if (!deal) {
        return apiError('Deal not found', 404);
      }
      if (!(await canAccessBdr(deal.bdr_id))) {
        return apiError('Forbidden', 403);
      }

      // Clear self-references (original_deal_id) before delete to avoid FK constraint
      db.prepare('UPDATE deals SET original_deal_id = NULL WHERE original_deal_id = ?').run(id);
      db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(id);
      db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(id);
      db.prepare('DELETE FROM deal_services WHERE deal_id = ?').run(id);
      db.prepare('DELETE FROM deals WHERE id = ?').run(id);
      return apiSuccess({ success: true });
    }

    const supabase = await createClient();
    const { data: deal } = await (supabase as any)
      .from('deals')
      .select('bdr_id')
      .eq('id', id)
      .single();
    if (!deal) {
      return apiError('Deal not found', 404);
    }
    if (!(await canAccessBdr(deal.bdr_id))) {
      return apiError('Forbidden', 403);
    }

    const result = await (supabase as any)
      .from('deals')
      .delete()
      .eq('id', id);
    const { error } = result as { error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess({ success: true });
  } catch (error: any) {
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}
