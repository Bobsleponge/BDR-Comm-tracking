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

      return apiSuccess(deal);
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
    const body = await request.json();
    
    // Validate input
    const validationResult = dealUpdateSchema.safeParse(body);
    if (!validationResult.success) {
      return apiError(
        `Validation error: ${validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        400
      );
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

      // Update deal
      const updateFields: string[] = [];
      const updateValues: any[] = [];

      const allowedFields = ['client_name', 'service_type', 'proposal_date', 'close_date', 
                            'first_invoice_date', 'deal_value', 'status', 'is_renewal', 
                            'payout_months', 'client_id', 'bdr_id', 'cancellation_date', 
                            'do_not_pay_future', 'original_deal_value', 'original_deal_id'];
      
      // Auto-calculate first_invoice_date if close_date is being updated
      let firstInvoiceDate = body.first_invoice_date;
      if (body.close_date !== undefined && !firstInvoiceDate) {
        const baseDate = body.close_date || deal.proposal_date;
        if (baseDate) {
          const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
          const calculatedDate = addDays(baseDateObj, 7);
          firstInvoiceDate = format(calculatedDate, 'yyyy-MM-dd');
        }
      } else if (body.proposal_date !== undefined && !body.close_date && !firstInvoiceDate && !deal.close_date) {
        // If proposal_date is updated and there's no close_date, calculate from proposal_date
        const baseDate = body.proposal_date;
        if (baseDate) {
          const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
          const calculatedDate = addDays(baseDateObj, 7);
          firstInvoiceDate = format(calculatedDate, 'yyyy-MM-dd');
        }
      }
      
      for (const [key, value] of Object.entries(body)) {
        if (allowedFields.includes(key) && value !== undefined) {
          updateFields.push(`${key} = ?`);
          updateValues.push(value);
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
      db.prepare(updateQuery).run(...updateValues);

      // If services array is provided, recalculate deal_value from services
      if (body.services && Array.isArray(body.services)) {
        const services = db.prepare('SELECT commissionable_value FROM deal_services WHERE deal_id = ?').all(id) as any[];
        const totalValue = services.reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
        db.prepare('UPDATE deals SET deal_value = ? WHERE id = ?').run(totalValue, id);
      }

      // Fetch updated deal with services
      const updatedDeal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(id) as any[];
      updatedDeal.deal_services = services;
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
    const updateBody = { ...body };
    if (body.close_date !== undefined && !body.first_invoice_date) {
      const baseDate = body.close_date || existingDeal.proposal_date;
      if (baseDate) {
        const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
        const calculatedDate = addDays(baseDateObj, 7);
        updateBody.first_invoice_date = format(calculatedDate, 'yyyy-MM-dd');
      }
    } else if (body.proposal_date !== undefined && !body.close_date && !body.first_invoice_date && !existingDeal.close_date) {
      // If proposal_date is updated and there's no close_date, calculate from proposal_date
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
    const { requireAdmin } = await import('@/lib/utils/api-helpers');
    await requireAdmin();
    const { id } = await params;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Check if deal exists
      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      if (!deal) {
        return apiError('Deal not found', 404);
      }

      // Delete deal (cascade will handle related records)
      db.prepare('DELETE FROM deals WHERE id = ?').run(id);

      return apiSuccess({ success: true });
    }

    const supabase = await createClient();
    const result = await (supabase
      .from('deals')
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
