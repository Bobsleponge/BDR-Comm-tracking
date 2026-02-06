import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { dealSchema, dealWithServicesSchema } from '@/lib/commission/validators';
import { scheduleCommissionPayouts, cancelFutureCommissionEntries } from '@/lib/commission/scheduler';
import { createRevenueEventsForDeal } from '@/lib/commission/revenue-events';
import { calculateServiceCommission } from '@/lib/commission/calculator';
import { addDays, parseISO, format } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    if (USE_LOCAL_DB) {
      // Local DB mode
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      
      if (!deal) {
        return apiError('Deal not found', 404);
      }

      // Check access
      if (!(await canAccessBdr(deal.bdr_id))) {
        return apiError('Forbidden', 403);
      }

      // Fetch services and client
      const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(id) as any[];
      const client = deal.client_id 
        ? db.prepare('SELECT * FROM clients WHERE id = ?').get(deal.client_id) as any
        : null;

      const dealWithServices = {
        ...deal,
        deal_services: services,
        clients: client,
      };

      return apiSuccess(dealWithServices);
    }

    // Supabase mode
    const supabase = await createClient();

    const query = (supabase as any)
      .from('deals')
      .select('*, deal_services(*), clients(*)')
      .eq('id', id)
      .single();
    const result = await query;
    const { data, error } = result as { data: any; error: any };

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
    
    // Handle services separately if provided
    let services: any[] | undefined;
    let dealUpdate: any;
    
    if (body.services !== undefined) {
      // For partial updates with services, validate services separately
      // and use dealSchema.partial() for the deal data
      const { services: servicesData, ...dealData } = body;
      if (servicesData !== undefined && Array.isArray(servicesData)) {
        services = servicesData;
      }
      dealUpdate = dealSchema.partial().parse(dealData);
      
      // Only derive service_type from first service if service_type is not in the update
      // AND services exist. Don't overwrite existing service_type unless explicitly changed.
      if (!dealUpdate.service_type && services && services.length > 0) {
        dealUpdate.service_type = services[0].service_name;
      }
    } else {
      dealUpdate = dealSchema.partial().parse(body);
    }
    
    // If service_type is provided in update, ensure it's trimmed
    if (dealUpdate.service_type !== undefined) {
      dealUpdate.service_type = dealUpdate.service_type.trim();
      if (dealUpdate.service_type === '') {
        return apiError('Service type cannot be empty', 400);
      }
    }

    if (USE_LOCAL_DB) {
      // Local DB mode
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Get existing deal
      const existingDeal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      
      if (!existingDeal) {
        return apiError('Deal not found', 404);
      }

      // Check access
      if (!(await canAccessBdr(existingDeal.bdr_id))) {
        return apiError('Forbidden', 403);
      }

      // If client_id is provided, ensure client_name matches
      if (dealUpdate.client_id) {
        const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(dealUpdate.client_id) as any;
        if (client) {
          dealUpdate.client_name = client.name;
        }
      }

      // Set default first_invoice_date to 5 days after close_date if close_date is being updated
      // and first_invoice_date is not explicitly provided
      if (dealUpdate.close_date !== undefined && dealUpdate.first_invoice_date === undefined) {
        const closeDate = dealUpdate.close_date ? parseISO(dealUpdate.close_date) : null;
        if (closeDate) {
          dealUpdate.first_invoice_date = format(addDays(closeDate, 5), 'yyyy-MM-dd');
        }
      } else if (dealUpdate.close_date !== undefined && !dealUpdate.first_invoice_date && dealUpdate.close_date) {
        // If close_date is provided but first_invoice_date is explicitly null/empty, set default
        const closeDate = parseISO(dealUpdate.close_date);
        dealUpdate.first_invoice_date = format(addDays(closeDate, 5), 'yyyy-MM-dd');
      }

      // Build update query dynamically based on what's being updated
      const updateFields: string[] = [];
      const updateValues: any[] = [];
      
      const allowedFields = [
        'client_id', 'client_name', 'service_type', 'proposal_date', 'close_date',
        'first_invoice_date', 'deal_value', 'status', 'is_renewal', 'original_deal_id',
        'payout_months', 'do_not_pay_future', 'original_deal_value'
      ];
      
      for (const field of allowedFields) {
        if (dealUpdate[field] !== undefined) {
          updateFields.push(`${field} = ?`);
          if (field === 'is_renewal' || field === 'do_not_pay_future') {
            updateValues.push((dealUpdate[field] === true || dealUpdate[field] === 1) ? 1 : 0);
          } else {
            updateValues.push(dealUpdate[field]);
          }
        }
      }
      
      if (updateFields.length > 0) {
        updateFields.push("updated_at = datetime('now')");
        updateValues.push(id);
        
        const updateQuery = `UPDATE deals SET ${updateFields.join(', ')} WHERE id = ?`;
        db.prepare(updateQuery).run(...updateValues);
      }

      // If services are provided, update them
      if (services !== undefined) {
        // Get commission rules for base rate
        const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
        const baseRate = rules?.base_rate ?? 0.025;

        // Delete existing services
        db.prepare('DELETE FROM deal_services WHERE deal_id = ?').run(id);

        // Insert updated services
        if (services.length > 0) {
          const { generateUUID } = await import('@/lib/utils/uuid');
          const serviceInsert = db.prepare(`
            INSERT INTO deal_services (
              id, deal_id, service_name, billing_type, unit_price, monthly_price,
              quarterly_price, quantity, contract_months, contract_quarters,
              commission_rate, commissionable_value, commission_amount, completion_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const service of services) {
            const { id: serviceId, ...serviceData } = service;
            const commission = calculateServiceCommission(
              serviceData.billing_type,
              serviceData.unit_price,
              serviceData.monthly_price ?? null,
              serviceData.quarterly_price ?? null,
              serviceData.quantity ?? 1,
              serviceData.contract_months ?? 12,
              serviceData.contract_quarters ?? 4,
              serviceData.commission_rate ?? null,
              baseRate
            );

            serviceInsert.run(
              generateUUID(),
              id,
              serviceData.service_name,
              serviceData.billing_type,
              serviceData.unit_price,
              serviceData.monthly_price || null,
              serviceData.quarterly_price || null,
              serviceData.quantity || 1,
              serviceData.contract_months || 12,
              serviceData.contract_quarters || 4,
              serviceData.commission_rate || null,
              commission.commissionable_value,
              commission.commission_amount,
              serviceData.completion_date || null
            );
          }
        }
      }

      // Fetch updated deal with services and client
      const updatedDeal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      const dealServices = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(id) as any[];
      const client = updatedDeal.client_id 
        ? db.prepare('SELECT * FROM clients WHERE id = ?').get(updatedDeal.client_id) as any
        : null;

      const dealWithServices = {
        ...updatedDeal,
        deal_services: dealServices,
        clients: client,
      };

      // If deal has first_invoice_date and isn't cancelled, create/update revenue events
      // This ensures all deals (proposed, closed-won, closed-lost) appear in commission structure
      if (!updatedDeal.cancellation_date && updatedDeal.first_invoice_date) {
        // Check if revenue events already exist - if not, create them
        const existingEvents = db.prepare('SELECT COUNT(*) as count FROM revenue_events WHERE deal_id = ?').get(updatedDeal.id) as any;
        if (!existingEvents || existingEvents.count === 0) {
          // No revenue events exist yet, create them
          try {
            await createRevenueEventsForDeal(updatedDeal.id);
          } catch (err) {
            console.error('Error creating revenue events:', err);
          }
        } else if (updatedDeal.status === 'closed-won' && existingDeal.status !== 'closed-won') {
          // Deal just changed to closed-won, ensure events are processed
          try {
            await createRevenueEventsForDeal(updatedDeal.id);
          } catch (err) {
            console.error('Error processing revenue events:', err);
          }
        }
      }

      return apiSuccess(dealWithServices);
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
    const { data: existingDeal, error: fetchError } = fetchResult as { data: any; error: any };

    if (fetchError || !existingDeal) {
      return apiError('Deal not found', 404);
    }

    // Check access
    if (!(await canAccessBdr(existingDeal.bdr_id))) {
      return apiError('Forbidden', 403);
    }

    // If client_id is provided, ensure client_name matches
    if (dealUpdate.client_id) {
      const clientQuery = (supabase as any)
        .from('clients')
        .select('name')
        .eq('id', dealUpdate.client_id)
        .single();
      const clientResult = await clientQuery;
      const { data: client } = clientResult as { data: any; error: any };
      
      if (client) {
        dealUpdate.client_name = client.name;
      }
    }

    // Set default first_invoice_date to 5 days after close_date if close_date is being updated
    // and first_invoice_date is not explicitly provided
    if (dealUpdate.close_date !== undefined && dealUpdate.first_invoice_date === undefined) {
      const closeDate = dealUpdate.close_date ? parseISO(dealUpdate.close_date) : null;
      if (closeDate) {
        dealUpdate.first_invoice_date = format(addDays(closeDate, 5), 'yyyy-MM-dd');
      }
    } else if (dealUpdate.close_date !== undefined && !dealUpdate.first_invoice_date && dealUpdate.close_date) {
      // If close_date is provided but first_invoice_date is explicitly null/empty, set default
      const closeDate = parseISO(dealUpdate.close_date);
      dealUpdate.first_invoice_date = format(addDays(closeDate, 5), 'yyyy-MM-dd');
    }

    // Update deal
    const updateQuery = (supabase as any)
      .from('deals')
      .update(dealUpdate)
      .eq('id', id)
      .select()
      .single();
    const updateResult = await updateQuery;
    const { data: updatedDeal, error: dealError } = updateResult as { data: any; error: any };

    if (dealError || !updatedDeal) {
      return apiError(dealError?.message || 'Failed to update deal', 500);
    }

    // If services are provided, update them
    if (services !== undefined) {
      // Get commission rules for base rate
      const rulesQuery = (supabase as any)
        .from('commission_rules')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
      const rulesResult = await rulesQuery;
      const { data: rules } = rulesResult as { data: any; error: any };

      const baseRate = rules?.base_rate ?? 0.025;

      // Delete existing services
      await (supabase.from('deal_services').delete().eq('deal_id', id) as any);

      // Insert updated services
      if (services.length > 0) {
        const servicesToInsert = services.map((service) => {
          const { id: serviceId, ...serviceData } = service;
          const commission = calculateServiceCommission(
            serviceData.billing_type,
            serviceData.unit_price,
            serviceData.monthly_price ?? null,
            serviceData.quarterly_price ?? null,
            serviceData.quantity ?? 1,
            serviceData.contract_months ?? 12,
            serviceData.contract_quarters ?? 4,
            serviceData.commission_rate ?? null,
            baseRate
          );

          return {
            ...serviceData,
            deal_id: id,
            commissionable_value: commission.commissionable_value,
            commission_amount: commission.commission_amount,
          };
        });

        const servicesResult = await (supabase
          .from('deal_services')
          .insert(servicesToInsert) as any);
        const { error: servicesError } = servicesResult as { error: any };

        if (servicesError) {
          return apiError(`Failed to update services: ${servicesError.message}`, 500);
        }
      }
    }

    // Fetch updated deal with services and client
    const finalQuery = (supabase as any)
      .from('deals')
      .select('*, deal_services(*), clients(*)')
      .eq('id', id)
      .single();
    const finalResult = await finalQuery;
    const { data: dealWithServices } = finalResult as { data: any; error: any };

    // If deal has first_invoice_date and isn't cancelled, create/update revenue events
    // This ensures all deals (proposed, closed-won, closed-lost) appear in commission structure
    if (!updatedDeal.cancellation_date && updatedDeal.first_invoice_date) {
      // Check if revenue events already exist - if not, create them
      const eventsQuery = (supabase as any)
        .from('revenue_events')
        .select('id')
        .eq('deal_id', id)
        .limit(1);
      const { data: existingEvents } = (await eventsQuery) as { data: any[] | null; error: any };
      
      if (!existingEvents || existingEvents.length === 0) {
        // No revenue events exist yet, create them
        try {
          await createRevenueEventsForDeal(id);
        } catch (err) {
          console.error('Error creating revenue events:', err);
        }
      } else if (updatedDeal.status === 'closed-won' && existingDeal.status !== 'closed-won') {
        // Deal just changed to closed-won, ensure events are processed
        try {
          await createRevenueEventsForDeal(id);
        } catch (err) {
          console.error('Error processing revenue events:', err);
        }
      }
    }

    return apiSuccess(dealWithServices || updatedDeal);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return apiError(`Validation error: ${error.errors.map((e: any) => e.message).join(', ')}`, 400);
    }
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
      // Local DB mode
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Check if deal exists
      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as any;
      if (!deal) {
        return apiError('Deal not found', 404);
      }

      // Delete deal (cascade will handle deal_services)
      db.prepare('DELETE FROM deals WHERE id = ?').run(id);

      return apiSuccess({ success: true });
    }

    // Supabase mode
    const supabase = await createClient();
    const deleteQuery = (supabase as any)
      .from('deals')
      .delete()
      .eq('id', id);
    const deleteResult = await deleteQuery;
    const { error } = deleteResult as { error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess({ success: true });
  } catch (error: any) {
    return apiError(error.message, error.message.includes('Forbidden') ? 403 : 401);
  }
}



