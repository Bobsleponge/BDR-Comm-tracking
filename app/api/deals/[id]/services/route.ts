import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { dealServiceSchema } from '@/lib/commission/validators';
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id: dealId } = await params;
    const body = await request.json();

    // Validate input
    const validationResult = dealServiceSchema.safeParse(body);
    if (!validationResult.success) {
      return apiError(
        `Validation error: ${validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        400
      );
    }

    const serviceData = validationResult.data;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const { generateUUID } = await import('@/lib/utils/uuid');
      const db = getLocalDB();

      // Check deal exists and access
      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
      if (!deal) {
        return apiError('Deal not found', 404);
      }

      if (!(await canAccessBdr(deal.bdr_id))) {
        return apiError('Forbidden', 403);
      }

      // Calculate commission
      const baseRate = await getBaseCommissionRate();
      const commission = calculateServiceCommission(
        serviceData.billing_type,
        serviceData.unit_price,
        serviceData.monthly_price || null,
        serviceData.quarterly_price || null,
        serviceData.quantity,
        serviceData.contract_months,
        serviceData.contract_quarters,
        serviceData.commission_rate || null,
        baseRate
      );

      const serviceId = generateUUID();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO deal_services (
          id, deal_id, service_name, service_type, billing_type, unit_price, monthly_price,
          quarterly_price, quantity, contract_months, contract_quarters,
          commission_rate, commissionable_value, commission_amount, completion_date,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        serviceId,
        dealId,
        serviceData.service_name,
        serviceData.service_type,
        serviceData.billing_type,
        serviceData.unit_price,
        serviceData.monthly_price || null,
        serviceData.quarterly_price || null,
        serviceData.quantity,
        serviceData.contract_months,
        serviceData.contract_quarters,
        serviceData.commission_rate || null,
        commission.commissionable_value,
        commission.commission_amount,
        serviceData.completion_date || null,
        now,
        now
      );

      // Update deal value
      await updateDealValue(dealId);

      const newService = db.prepare('SELECT * FROM deal_services WHERE id = ?').get(serviceId) as any;
      return apiSuccess(newService, 201);
    }

    const supabase = await createClient();

    // Check deal exists and access
    const { data: deal, error: dealError } = await (supabase as any)
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .single();

    if (dealError || !deal) {
      return apiError('Deal not found', 404);
    }

    if (!(await canAccessBdr(deal.bdr_id))) {
      return apiError('Forbidden', 403);
    }

    // Calculate commission
    const baseRate = await getBaseCommissionRate();
    const commission = calculateServiceCommission(
      serviceData.billing_type,
      serviceData.unit_price,
      serviceData.monthly_price || null,
      serviceData.quarterly_price || null,
      serviceData.quantity,
      serviceData.contract_months,
      serviceData.contract_quarters,
      serviceData.commission_rate || null,
      baseRate
    );

    const { data: newService, error } = await (supabase as any)
      .from('deal_services')
      .insert({
        deal_id: dealId,
        service_name: serviceData.service_name,
        service_type: serviceData.service_type,
        billing_type: serviceData.billing_type,
        unit_price: serviceData.unit_price,
        monthly_price: serviceData.monthly_price || null,
        quarterly_price: serviceData.quarterly_price || null,
        quantity: serviceData.quantity,
        contract_months: serviceData.contract_months,
        contract_quarters: serviceData.contract_quarters,
        commission_rate: serviceData.commission_rate || null,
        commissionable_value: commission.commissionable_value,
        commission_amount: commission.commission_amount,
        completion_date: serviceData.completion_date || null,
      })
      .select()
      .single();

    if (error) {
      return apiError(error.message, 500);
    }

    // Update deal value
    await updateDealValue(dealId);

    return apiSuccess(newService, 201);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

