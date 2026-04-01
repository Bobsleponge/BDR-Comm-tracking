import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { dealServiceUpdateSchema } from '@/lib/commission/validators';
import { calculateServiceCommission, calculateRenewalCommission } from '@/lib/commission/calculator';

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

async function setDealFirstInvoiceDate(dealId: string, firstInvoiceDate: string) {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();
    db.prepare('UPDATE deals SET first_invoice_date = ?, updated_at = datetime(\'now\') WHERE id = ?').run(firstInvoiceDate, dealId);
  } else {
    const supabase = await createClient();
    await (supabase as any).from('deals').update({ first_invoice_date: firstInvoiceDate }).eq('id', dealId);
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

      // Calculate commission - for renewals use uplift; percentage_of_net_sales uses 0
      const baseRate = await getBaseCommissionRate();
      const unitPrice = mergedData.billing_type === 'percentage_of_net_sales' ? 0 : (mergedData.unit_price ?? service.unit_price ?? 0);
      const commission = calculateServiceCommission(
        mergedData.billing_type,
        unitPrice,
        mergedData.monthly_price || null,
        mergedData.quarterly_price || null,
        mergedData.quantity,
        mergedData.contract_months,
        mergedData.contract_quarters,
        mergedData.commission_rate || null,
        baseRate
      );

      // Determine values for renewal fields (handle both direct update and merged from existing)
      const isRenewal = updateData.is_renewal !== undefined
        ? (updateData.is_renewal ? 1 : 0)
        : (service.is_renewal ?? 0);
      const originalServiceValue = updateData.original_service_value !== undefined
        ? updateData.original_service_value
        : service.original_service_value;

      // For renewal services: commission on uplift only
      let commissionableValue = commission.commissionable_value;
      let commissionAmount = commission.commission_amount;
      if (isRenewal && originalServiceValue != null) {
        const uplift = Math.max(0, commission.commissionable_value - originalServiceValue);
        const rate = mergedData.commission_rate ?? baseRate;
        commissionAmount = Number(calculateRenewalCommission(
          commission.commissionable_value,
          originalServiceValue,
          rate
        ).toFixed(2));
      }

      const toBind = (v: any): string | number | null => (v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
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
          billing_percentage = ?,
          commissionable_value = ?,
          commission_amount = ?,
          completion_date = ?,
          is_renewal = ?,
          original_service_value = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        mergedData.service_name,
        mergedData.service_type,
        mergedData.billing_type,
        unitPrice,
        toBind(mergedData.monthly_price),
        toBind(mergedData.quarterly_price),
        mergedData.quantity ?? 1,
        mergedData.contract_months ?? 12,
        mergedData.contract_quarters ?? 4,
        toBind(mergedData.commission_rate),
        toBind(mergedData.billing_percentage),
        commissionableValue,
        commissionAmount,
        toBind(mergedData.completion_date),
        isRenewal,
        toBind(originalServiceValue),
        serviceId
      );

      // Update deal value
      await updateDealValue(dealId);

      // For paid_on_completion: set first_invoice_date = expected completion date (scheduled payment)
      if (mergedData.billing_type === 'paid_on_completion' && mergedData.completion_date) {
        const dateStr = typeof mergedData.completion_date === 'string'
          ? mergedData.completion_date.split('T')[0]
          : mergedData.completion_date;
        await setDealFirstInvoiceDate(dealId, dateStr);
      }

      // Reprocess deal: recreate revenue events and commission entries with updated service data
      const { createRevenueEventsForDeal, processRevenueEvent } = await import('@/lib/commission/revenue-events');
      db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(dealId);
      db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);
      await createRevenueEventsForDeal(dealId);
      const revenueEvents = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ?').all(dealId) as Array<{ id: string }>;
      for (const ev of revenueEvents) {
        try {
          await processRevenueEvent(ev.id);
        } catch {
          // Ignore individual processing errors
        }
      }

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

    // Calculate commission - for renewals use uplift; percentage_of_net_sales uses 0
    const baseRate = await getBaseCommissionRate();
    const unitPrice = mergedData.billing_type === 'percentage_of_net_sales' ? 0 : (mergedData.unit_price ?? service.unit_price ?? 0);
    const commission = calculateServiceCommission(
      mergedData.billing_type,
      unitPrice,
      mergedData.monthly_price || null,
      mergedData.quarterly_price || null,
      mergedData.quantity,
      mergedData.contract_months,
      mergedData.contract_quarters,
      mergedData.commission_rate || null,
      baseRate
    );

    const isRenewal = updateData.is_renewal !== undefined
      ? !!updateData.is_renewal
      : (service.is_renewal ?? false);
    const originalServiceValue = updateData.original_service_value !== undefined
      ? updateData.original_service_value
      : service.original_service_value;

    let commissionableValue = commission.commissionable_value;
    let commissionAmount = commission.commission_amount;
    if (isRenewal && originalServiceValue != null) {
      const rate = mergedData.commission_rate ?? baseRate;
      commissionAmount = Number(calculateRenewalCommission(
        commission.commissionable_value,
        originalServiceValue,
        rate
      ).toFixed(2));
    }

    const updatePayload: Record<string, any> = {
      ...updateData,
      unit_price: unitPrice,
      commissionable_value: commissionableValue,
      commission_amount: commissionAmount,
    };
    if (updateData.is_renewal !== undefined) {
      updatePayload.is_renewal = isRenewal;
    }
    if (updateData.original_service_value !== undefined) {
      updatePayload.original_service_value = originalServiceValue;
    }

    const { data: updatedService, error } = await (supabase as any)
      .from('deal_services')
      .update(updatePayload)
      .eq('id', serviceId)
      .select()
      .single();

    if (error) {
      return apiError(error.message, 500);
    }

    // Update deal value
    await updateDealValue(dealId);

    // For paid_on_completion: set first_invoice_date = expected completion date (scheduled payment)
    const finalData = updatedService || { ...service, ...updateData };
    if (finalData.billing_type === 'paid_on_completion' && finalData.completion_date) {
      const dateStr = typeof finalData.completion_date === 'string'
        ? finalData.completion_date.split('T')[0]
        : finalData.completion_date;
      await setDealFirstInvoiceDate(dealId, dateStr);
    }

    // Reprocess deal: recreate revenue events and commission entries
    const { createRevenueEventsForDeal, processRevenueEvent } = await import('@/lib/commission/revenue-events');
    await (supabase as any).from('commission_entries').delete().eq('deal_id', dealId);
    await (supabase as any).from('revenue_events').delete().eq('deal_id', dealId);
    await createRevenueEventsForDeal(dealId);
    const eventsResult = await (supabase as any).from('revenue_events').select('id').eq('deal_id', dealId);
    const revenueEvents = eventsResult.data || [];
    for (const ev of revenueEvents) {
      try {
        await processRevenueEvent(ev.id);
      } catch {
        // Ignore individual processing errors
      }
    }

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

      // Reprocess deal: recreate revenue events and commission entries without deleted service
      const { createRevenueEventsForDeal, processRevenueEvent } = await import('@/lib/commission/revenue-events');
      db.prepare('DELETE FROM commission_entries WHERE deal_id = ?').run(dealId);
      db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);
      const remainingServices = db.prepare('SELECT id FROM deal_services WHERE deal_id = ?').all(dealId) as any[];
      if (remainingServices.length > 0) {
        await createRevenueEventsForDeal(dealId);
        const revenueEvents = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ?').all(dealId) as Array<{ id: string }>;
        for (const ev of revenueEvents) {
          try {
            await processRevenueEvent(ev.id);
          } catch {
            // Ignore
          }
        }
      }

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

    // Reprocess deal: recreate revenue events and commission entries
    const { createRevenueEventsForDeal, processRevenueEvent } = await import('@/lib/commission/revenue-events');
    await (supabase as any).from('commission_entries').delete().eq('deal_id', dealId);
    await (supabase as any).from('revenue_events').delete().eq('deal_id', dealId);
    const { data: remainingServices } = await (supabase as any).from('deal_services').select('id').eq('deal_id', dealId);
    if (remainingServices && remainingServices.length > 0) {
      await createRevenueEventsForDeal(dealId);
      const eventsResult = await (supabase as any).from('revenue_events').select('id').eq('deal_id', dealId);
      const revenueEvents = eventsResult.data || [];
      for (const ev of revenueEvents) {
        try {
          await processRevenueEvent(ev.id);
        } catch {
          // Ignore
        }
      }
    }

    return apiSuccess({ success: true });
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

