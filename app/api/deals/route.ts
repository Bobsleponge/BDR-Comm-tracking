import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { dealSchema, dealWithServicesSchema } from '@/lib/commission/validators';
import { createRevenueEventsForDeal } from '@/lib/commission/revenue-events';
import { calculateServiceCommission, calculateDealTotalCommission } from '@/lib/commission/calculator';
import { generateUUID } from '@/lib/utils/uuid';
import { addDays, parseISO, format } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');
    const status = searchParams.get('status');
    const clientName = searchParams.get('client_name');

    const { isAdmin } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    if (USE_LOCAL_DB) {
      // Local DB mode
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Determine which BDR to query
      let targetBdrId = bdrId;
      if (!isUserAdmin) {
        const { getBdrIdFromUser } = await import('@/lib/utils/auth');
        const userBdrId = await getBdrIdFromUser();
        if (!userBdrId) {
          return apiError('BDR profile not found', 404);
        }
        targetBdrId = userBdrId;
      }

      // Build query
      let query = 'SELECT * FROM deals WHERE 1=1';
      const params: any[] = [];

      if (targetBdrId) {
        query += ' AND bdr_id = ?';
        params.push(targetBdrId);
      }

      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }

      if (clientName) {
        query += ' AND client_name LIKE ?';
        params.push(`%${clientName}%`);
      }

      query += ' ORDER BY created_at DESC';

      // OPTIMIZATION: Use JOIN to get deals + clients in ONE query instead of multiple
      // Skip deal_services entirely for list view (not displayed, saves huge amount of data)
      const dealsQuery = `
        SELECT 
          d.*,
          c.id as client_table_id,
          c.name as client_table_name,
          c.company as client_company,
          c.email as client_email,
          c.phone as client_phone
        FROM deals d
        LEFT JOIN clients c ON d.client_id = c.id
        WHERE 1=1
        ${targetBdrId ? 'AND d.bdr_id = ?' : ''}
        ${status ? 'AND d.status = ?' : ''}
        ${clientName ? 'AND d.client_name LIKE ?' : ''}
        ORDER BY d.created_at DESC
        LIMIT 500
      `;

      const deals = db.prepare(dealsQuery).all(...params) as any[];

      if (deals.length === 0) {
        return apiSuccess([], 200, { cache: 10 });
      }

      // Transform results - skip deal_services for list view (not needed, saves time)
      const dealsWithRelations = deals.map(deal => ({
        ...deal,
        deal_services: [], // Empty array - services not needed for list view
        clients: deal.client_table_id ? {
          id: deal.client_table_id,
          name: deal.client_table_name,
          company: deal.client_company,
          email: deal.client_email,
          phone: deal.client_phone,
        } : null,
      }));

      return apiSuccess(dealsWithRelations, 200, { cache: 30 }); // Increased cache to 30 seconds
    }

    // Supabase mode
    const supabase = await createClient();

    let query: any = ((supabase as any)
      .from('deals')
      .select('*, deal_services(*), clients(*)')
      .order('created_at', { ascending: false }));

    // If not admin, only show own deals
    if (!isUserAdmin) {
      const { getBdrIdFromUser } = await import('@/lib/utils/auth');
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      query = query.eq('bdr_id', userBdrId);
    } else if (bdrId) {
      query = query.eq('bdr_id', bdrId);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (clientName) {
      query = query.ilike('client_name', `%${clientName}%`);
    }

    const { data, error } = (await query) as { data: any[] | null; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data, 200, { cache: 10 }); // Cache for 10 seconds
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    const body = await request.json();

    // Check if services exist in body BEFORE attempting validation
    const hasServicesInBody = body.services !== undefined && Array.isArray(body.services) && body.services.length > 0;

    // Validate input - try dealWithServicesSchema first, fall back to dealSchema for backward compatibility
    let validated: any;
    let services: any[] | undefined;
    
    try {
      const validatedWithServices = dealWithServicesSchema.parse(body);
      services = validatedWithServices.services;
      // Remove services from validated object for deal insertion
      const { services: _, ...dealData } = validatedWithServices;
      validated = dealSchema.parse(dealData);
      
      // Only derive service_type from first service if service_type is explicitly missing/empty
      // AND services exist. Don't overwrite if service_type was explicitly provided.
      if ((!validated.service_type || validated.service_type.trim() === '') && services && services.length > 0) {
        validated.service_type = services[0].service_name;
      }
    } catch (e: any) {
      // If services were provided but validation failed, return error with details
      if (hasServicesInBody) {
        const errorMessage = e.errors?.map((err: any) => 
          `${err.path.join('.')}: ${err.message}`
        ).join(', ') || e.message || 'Service validation failed';
        return apiError(`Service validation failed: ${errorMessage}`, 400);
      }
      // Only fall back to legacy if services weren't provided
      validated = dealSchema.parse(body);
      services = undefined;
      
      // For legacy mode, ensure service_type is provided
      if (!validated.service_type || validated.service_type.trim() === '') {
        return apiError('Service type is required', 400);
      }
    }
    
    // Final check: service_type must be present and not empty
    if (!validated.service_type || validated.service_type.trim() === '') {
      return apiError('Service type is required', 400);
    }
    
    validated.service_type = validated.service_type.trim();

    // If not admin, ensure bdr_id matches user's BDR ID
    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    if (!(await isAdmin())) {
      const userBdrId = await getBdrIdFromUser();
      if (userBdrId !== validated.bdr_id) {
        return apiError('Cannot create deals for other BDRs', 403);
      }
    }

    if (USE_LOCAL_DB) {
      // Local DB mode
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Verify BDR ID exists
      const bdr = db.prepare('SELECT id FROM bdr_reps WHERE id = ?').get(validated.bdr_id) as any;
      if (!bdr) {
        return apiError(`Invalid BDR ID: BDR with ID "${validated.bdr_id}" not found`, 400);
      }

      // Get commission rules for base rate
      const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
      const baseRate = rules?.base_rate ?? 0.025;

      // If client_id is provided, ensure client_name matches
      if (validated.client_id) {
        const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(validated.client_id) as any;
        if (client) {
          validated.client_name = client.name;
        }
      }

      // Set default first_invoice_date to 5 days after close_date if not provided
      if (!validated.first_invoice_date && validated.close_date) {
        const closeDate = parseISO(validated.close_date);
        validated.first_invoice_date = format(addDays(closeDate, 5), 'yyyy-MM-dd');
      }

      // Generate deal ID
      const dealId = generateUUID();
      validated.id = dealId;

      // Insert deal
      const dealInsert = db.prepare(`
        INSERT INTO deals (
          id, bdr_id, client_id, client_name, service_type, proposal_date, close_date,
          first_invoice_date, deal_value, status, is_renewal, original_deal_id,
          payout_months, do_not_pay_future, original_deal_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      dealInsert.run(
        validated.id,
        validated.bdr_id,
        validated.client_id || null,
        validated.client_name,
        validated.service_type,
        validated.proposal_date,
        validated.close_date || null,
        validated.first_invoice_date || null,
        validated.deal_value,
        validated.status,
        (validated.is_renewal === true || validated.is_renewal === 1) ? 1 : 0,
        validated.original_deal_id || null,
        validated.payout_months || 12,
        (validated.do_not_pay_future === true || validated.do_not_pay_future === 1) ? 1 : 0,
        validated.original_deal_value || null
      );

      // If services are provided, calculate and insert them
      if (services && services.length > 0) {
        try {
          for (const service of services) {
            const { id, ...serviceData } = service;
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

            const serviceId = generateUUID();
            const serviceInsert = db.prepare(`
              INSERT INTO deal_services (
                id, deal_id, service_name, billing_type, unit_price, monthly_price,
                quarterly_price, quantity, contract_months, contract_quarters,
                commission_rate, commissionable_value, commission_amount, completion_date
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            try {
              serviceInsert.run(
                serviceId,
                dealId,
                serviceData.service_name,
                serviceData.billing_type,
                serviceData.unit_price ?? 0, // Default to 0 for MRR/quarterly services that don't use unit_price
                serviceData.monthly_price || null,
                serviceData.quarterly_price || null,
                serviceData.quantity,
                serviceData.contract_months,
                serviceData.contract_quarters,
                serviceData.commission_rate || null,
                commission.commissionable_value,
                commission.commission_amount,
                serviceData.completion_date || null
              );
            } catch (insertError: any) {
              // Rollback deal if service insertion fails
              db.prepare('DELETE FROM deals WHERE id = ?').run(dealId);
              return apiError(`Failed to insert service "${serviceData.service_name}": ${insertError.message}`, 500);
            }
          }

          // Verify all services were saved
          const savedServices = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(dealId) as any[];
          if (savedServices.length !== services.length) {
            // Rollback deal if not all services were saved
            db.prepare('DELETE FROM deals WHERE id = ?').run(dealId);
            return apiError(`Failed to save all services. Expected ${services.length}, saved ${savedServices.length}`, 500);
          }
        } catch (serviceError: any) {
          // Rollback deal if any service operation fails
          db.prepare('DELETE FROM deals WHERE id = ?').run(dealId);
          return apiError(`Failed to process services: ${serviceError.message}`, 500);
        }
      }

      // Fetch deal with services for response
      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
      const dealServices = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(dealId) as any[];
      
      const dealWithServices = {
        ...deal,
        deal_services: dealServices,
      };

      // Generate revenue events for all deals (unless cancelled) that have first_invoice_date
      // This ensures all deals appear in the commission structure automatically
      if (!deal.cancellation_date && deal.first_invoice_date) {
        try {
          // Create revenue events and process immediate ones synchronously
          // This ensures commission entries appear on the commission page immediately
          await createRevenueEventsForDeal(deal.id);
        } catch (err: any) {
          // Log error but don't fail the deal creation
          console.error('Error creating revenue events for deal:', deal.id, err);
          // Still return success - deal is created, commission can be processed later
        }
      }

      return apiSuccess(dealWithServices, 201);
    }

    // Supabase mode
    const supabase = await createClient();

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

    // If client_id is provided, ensure client_name matches
    if (validated.client_id) {
      const clientQuery = (supabase as any)
        .from('clients')
        .select('name')
        .eq('id', validated.client_id)
        .single();
      const clientResult = await clientQuery;
      const { data: client } = clientResult as { data: any; error: any };
      
      if (client) {
        validated.client_name = client.name;
      }
    }

    // Set default first_invoice_date to 5 days after close_date if not provided
    if (!validated.first_invoice_date && validated.close_date) {
      const closeDate = parseISO(validated.close_date);
      validated.first_invoice_date = format(addDays(closeDate, 5), 'yyyy-MM-dd');
    }

    // Insert deal
    const dealQuery = (supabase as any)
      .from('deals')
      .insert(validated)
      .select()
      .single();
    const dealResult = await dealQuery;
    const { data: deal, error: dealError } = dealResult as { data: any; error: any };

    if (dealError || !deal) {
      return apiError(dealError?.message || 'Failed to create deal', 500);
    }

    // If services are provided, calculate and insert them
    if (services && services.length > 0) {
      const servicesToInsert = services.map((service) => {
        const { id, ...serviceData } = service;
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
          deal_id: deal.id,
          commissionable_value: commission.commissionable_value,
          commission_amount: commission.commission_amount,
        };
      });

        const servicesResult = await (supabase
          .from('deal_services')
          .insert(servicesToInsert) as any);
        const { error: servicesError } = servicesResult as { error: any };

        if (servicesError) {
          // Rollback deal if services insertion fails
          await (supabase.from('deals').delete().eq('id', deal.id) as any);
        return apiError(`Failed to create services: ${servicesError.message}`, 500);
      }
    }

    // Fetch deal with services for response
    const finalQuery = (supabase as any)
      .from('deals')
      .select('*, deal_services(*)')
      .eq('id', deal.id)
      .single();
    const finalResult = await finalQuery;
    const { data: dealWithServices } = finalResult as { data: any; error: any };

    // Generate revenue events for all deals (unless cancelled) that have first_invoice_date
    // This ensures all deals appear in the commission structure automatically
    if (!deal.cancellation_date && deal.first_invoice_date) {
      try {
        // Create revenue events and process immediate ones synchronously
        // This ensures commission entries appear on the commission page immediately
        await createRevenueEventsForDeal(deal.id);
      } catch (err: any) {
        // Log error but don't fail the deal creation
        console.error('Error creating revenue events for deal:', deal.id, err);
        // Still return success - deal is created, commission can be processed later
      }
    }

    return apiSuccess(dealWithServices || deal, 201);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return apiError(`Validation error: ${error.errors.map((e: any) => e.message).join(', ')}`, 400);
    }
    return apiError(error.message, 401);
  }
}



