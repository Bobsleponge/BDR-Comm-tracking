import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { dealServiceUpdateSchema } from '@/lib/commission/validators';
import { calculateServiceCommission } from '@/lib/commission/calculator';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function getBaseCommissionRate(): Promise<number> {
  try {
    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const rules = db.prepare('SELECT base_rate FROM commission_rules LIMIT 1').get() as any;
      return rules?.base_rate || 0.025;
    } else {
      const supabase = await createClient();
      const { data } = await (supabase as any)
        .from('commission_rules')
        .select('base_rate')
        .limit(1)
        .single();
      return data?.base_rate || 0.025;
    }
  } catch {
    return 0.025;
  }
}

async function updateDealValue(dealId: string) {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();
    const services = db.prepare('SELECT commissionable_value FROM deal_services WHERE deal_id = ?').all(dealId) as any[];
    const totalValue = services.reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
    db.prepare('UPDATE deals SET deal_value = ?, updated_at = datetime(\'now\') WHERE id = ?').run(totalValue, dealId);
  } else {
    const supabase = await createClient();
    const { data: services } = await (supabase as any)
      .from('deal_services')
      .select('commissionable_value')
      .eq('deal_id', dealId);
    const totalValue = services?.reduce((sum: number, s: any) => sum + (s.commissionable_value || 0), 0) || 0;
    await (supabase as any)
      .from('deals')
      .update({ deal_value: totalValue })
      .eq('id', dealId);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; serviceId: string }> }
) {
  try {
    await requireAuth();
    const { id: dealId, serviceId } = await params;
    const body = await request.json();

    // Validate input
    const validationResult = dealServiceUpdateSchema.safeParse(body);
    if (!validationResult.success) {
      return apiError(
        `Validation error: ${validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        400
      );
    }

    const updateData = validationResult.data;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Check service exists and get deal
      const service = db.prepare('SELECT * FROM deal_services WHERE id = ? AND deal_id = ?').get(serviceId, dealId) as any;
      if (!service) {
        return apiError('Service not found', 404);
      }

      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
      if (!deal) {
        return apiError('Deal not found', 404);
      }

      if (!(await canAccessBdr(deal.bdr_id))) {
        return apiError('Forbidden', 403);
      }

      // Merge update data with existing service
      const mergedData = {
        ...service,
        ...updateData,
      };

      // Calculate commission if pricing fields changed
      const baseRate = await getBaseCommissionRate();
      const commission = calculateServiceCommission(
        mergedData.billing_type,
        mergedData.unit_price,
        mergedData.monthly_price || null,
        mergedData.quarterly_price || null,
        mergedData.quantity,
        mergedData.contract_months,
        mergedData.contract_quarters,
        mergedData.commission_rate || null,
        baseRate
      );

      // Update service
      db.prepare(`
        UPDATE deal_services SET
          service_name = ?,
          service_type = ?,
          billing_type = ?,
          unit_price = ?,
          monthly_price = ?,
          quarterly_price = ?,
          quantity = ?,
          contract_months = ?,
          contract_quarters = ?,
          commission_rate = ?,
          commissionable_value = ?,
          commission_amount = ?,
          completion_date = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        mergedData.service_name,
        mergedData.service_type,
        mergedData.billing_type,
        mergedData.unit_price,
        mergedData.monthly_price || null,
        mergedData.quarterly_price || null,
        mergedData.quantity,
        mergedData.contract_months,
        mergedData.contract_quarters,
        mergedData.commission_rate || null,
        commission.commissionable_value,
        commission.commission_amount,
        mergedData.completion_date || null,
        serviceId
      );

      // Update deal value
      await updateDealValue(dealId);

      const updatedService = db.prepare('SELECT * FROM deal_services WHERE id = ?').get(serviceId) as any;
      return apiSuccess(updatedService);
    }

    const supabase = await createClient();

    // Check service exists and get deal
    const { data: service, error: serviceError } = await (supabase as any)
      .from('deal_services')
      .select('*, deals!inner(*)')
      .eq('id', serviceId)
      .eq('deal_id', dealId)
      .single();

    if (serviceError || !service) {
      return apiError('Service not found', 404);
    }

    if (!(await canAccessBdr(service.deals.bdr_id))) {
      return apiError('Forbidden', 403);
    }

    // Merge update data with existing service
    const mergedData = {
      ...service,
      ...updateData,
    };

    // Calculate commission
    const baseRate = await getBaseCommissionRate();
    const commission = calculateServiceCommission(
      mergedData.billing_type,
      mergedData.unit_price,
      mergedData.monthly_price || null,
      mergedData.quarterly_price || null,
      mergedData.quantity,
      mergedData.contract_months,
      mergedData.contract_quarters,
      mergedData.commission_rate || null,
      baseRate
    );

    const { data: updatedService, error } = await (supabase as any)
      .from('deal_services')
      .update({
        ...updateData,
        commissionable_value: commission.commissionable_value,
        commission_amount: commission.commission_amount,
      })
      .eq('id', serviceId)
      .select()
      .single();

    if (error) {
      return apiError(error.message, 500);
    }

    // Update deal value
    await updateDealValue(dealId);

    return apiSuccess(updatedService);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; serviceId: string }> }
) {
  try {
    await requireAuth();
    const { id: dealId, serviceId } = await params;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Check service exists and get deal
      const service = db.prepare('SELECT * FROM deal_services WHERE id = ? AND deal_id = ?').get(serviceId, dealId) as any;
      if (!service) {
        return apiError('Service not found', 404);
      }

      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
      if (!deal) {
        return apiError('Deal not found', 404);
      }

      if (!(await canAccessBdr(deal.bdr_id))) {
        return apiError('Forbidden', 403);
      }

      // Delete service
      db.prepare('DELETE FROM deal_services WHERE id = ?').run(serviceId);

      // Update deal value
      await updateDealValue(dealId);

      return apiSuccess({ success: true });
    }

    const supabase = await createClient();

    // Check service exists and get deal
    const { data: service, error: serviceError } = await (supabase as any)
      .from('deal_services')
      .select('*, deals!inner(*)')
      .eq('id', serviceId)
      .eq('deal_id', dealId)
      .single();

    if (serviceError || !service) {
      return apiError('Service not found', 404);
    }

    if (!(await canAccessBdr(service.deals.bdr_id))) {
      return apiError('Forbidden', 403);
    }

    const { error } = await (supabase as any)
      .from('deal_services')
      .delete()
      .eq('id', serviceId);

    if (error) {
      return apiError(error.message, 500);
    }

    // Update deal value
    await updateDealValue(dealId);

    return apiSuccess({ success: true });
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

