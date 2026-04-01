import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { parseISO, addDays, format } from 'date-fns';
import { dealSchema } from '@/lib/commission/validators';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const bdrIdParam = searchParams.get('bdr_id');
    
    // Pagination parameters
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
    const offset = (page - 1) * limit;

    // Check if user is admin
    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();
    const userBdrId = await getBdrIdFromUser();

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      let query = 'SELECT deals.*, clients.name as client_name_from_client, clients.company FROM deals LEFT JOIN clients ON deals.client_id = clients.id WHERE 1=1';
      const params: any[] = [];

      // Filter by BDR ID (admin can see all, BDR sees only their own)
      if (!isUserAdmin) {
        query += ' AND deals.bdr_id = ?';
        params.push(userBdrId);
      } else if (bdrIdParam) {
        query += ' AND deals.bdr_id = ?';
        params.push(bdrIdParam);
      }

      // Filter by status
      if (status) {
        query += ' AND deals.status = ?';
        params.push(status);
      }

      // Get total count for pagination
      let countQuery = 'SELECT COUNT(*) as total FROM deals LEFT JOIN clients ON deals.client_id = clients.id WHERE 1=1';
      const countParams: any[] = [];
      
      if (!isUserAdmin) {
        countQuery += ' AND deals.bdr_id = ?';
        countParams.push(userBdrId);
      } else if (bdrIdParam) {
        countQuery += ' AND deals.bdr_id = ?';
        countParams.push(bdrIdParam);
      }
      
      if (status) {
        countQuery += ' AND deals.status = ?';
        countParams.push(status);
      }
      
      const totalResult = db.prepare(countQuery).get(...countParams) as { total: number };
      const total = totalResult?.total || 0;

      // For closed-won deals, sort by close date (most recently closed first)
      const orderBy = status === 'closed-won'
        ? 'ORDER BY COALESCE(deals.close_date, deals.proposal_date, deals.created_at) DESC'
        : 'ORDER BY deals.created_at DESC';
      query += ` ${orderBy} LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const deals = db.prepare(query).all(...params) as any[];

      // Deal IDs that have commission batch overrides
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

      // Get deal services and has_override for each deal
      for (const deal of deals) {
        const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(deal.id) as any[];
        deal.deal_services = services;
        deal.has_override = overrideDealIds.has(deal.id);
      }

      return apiSuccess({
        data: deals,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      }, 200, { cache: 'no-store' });
    }

    const supabase = await createClient();
    // For closed-won deals, sort by close date (most recently closed first)
    const orderCol = status === 'closed-won' ? 'close_date' : 'created_at';
    let query = (supabase as any)
      .from('deals')
      .select('*, deal_services(*), clients(*)')
      .order(orderCol, { ascending: false, nullsFirst: false });

    // Filter by BDR ID
    if (!isUserAdmin) {
      query = query.eq('bdr_id', userBdrId);
    } else if (bdrIdParam) {
      query = query.eq('bdr_id', bdrIdParam);
    }

    // Filter by status
    if (status) {
      query = query.eq('status', status);
    }

    // Add pagination
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = (await query) as { data: any[] | null; error: any; count?: number };

    if (error) {
      return apiError(error.message, 500);
    }

    const dealsData = data || [];
    const dealIds = dealsData.map((d: any) => d.id).filter(Boolean);

    // Deal IDs that have commission batch overrides (Supabase)
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

    // Get total count if not provided
    let total = count;
    if (total === undefined) {
      const countQuery = query.select('id', { count: 'exact', head: true });
      const { count: totalCount } = (await countQuery) as { count: number | null };
      total = totalCount || (data?.length || 0);
    }

    return apiSuccess({
      data: dealsData,
      pagination: {
        page,
        limit,
        total: total || (data?.length || 0),
        totalPages: Math.ceil((total || (data?.length || 0)) / limit),
      },
    }, 200, { cache: 'no-store' });
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    const body = await request.json();
    
    // Validate input
    const validationResult = dealSchema.safeParse(body);
    if (!validationResult.success) {
      return apiError(
        `Validation error: ${validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        400
      );
    }

    // All deals must be associated to a client
    const clientId = body.client_id;
    if (!clientId || typeof clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      return apiError('Client is required. Please select a client for this deal.', 400);
    }
    
    const { getBdrIdFromUser } = await import('@/lib/utils/auth');
    const userBdrId = await getBdrIdFromUser();

    if (!userBdrId) {
      return apiError('User BDR ID not found', 400);
    }

    // Use provided bdr_id or default to current user's BDR ID
    const bdrId = body.bdr_id || userBdrId;

    // Check if user is admin or creating for themselves
    const { isAdmin } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();
    if (!isUserAdmin && bdrId !== userBdrId) {
      return apiError('Forbidden: Can only create deals for yourself', 403);
    }

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const { generateUUID } = await import('@/lib/utils/uuid');
      const db = getLocalDB();

      const dealId = generateUUID();
      const now = new Date().toISOString();

      // Auto-calculate first_invoice_date = close_date + 7 days (or proposal_date + 7 days if close_date is null)
      let firstInvoiceDate = body.first_invoice_date || null;
      if (!firstInvoiceDate) {
        const baseDate = body.close_date || body.proposal_date || now.split('T')[0];
        if (baseDate) {
          const baseDateObj = parseISO(baseDate);
          const calculatedDate = addDays(baseDateObj, 7);
          firstInvoiceDate = format(calculatedDate, 'yyyy-MM-dd');
        }
      }

      const deal = {
        id: dealId,
        bdr_id: bdrId,
        client_id: clientId,
        client_name: body.client_name || '',
        service_type: body.service_type || 'Multiple Services', // Default for deals with multiple services
        proposal_date: body.proposal_date || now.split('T')[0],
        close_date: body.close_date || null,
        first_invoice_date: firstInvoiceDate,
        deal_value: body.deal_value || 0,
        original_deal_value: body.is_renewal ? (body.original_deal_value ?? null) : (body.original_deal_value ?? body.deal_value ?? 0),
        status: body.status || 'proposed',
        is_renewal: body.is_renewal ? 1 : 0,
        original_deal_id: body.original_deal_id || null,
        cancellation_date: null,
        payout_months: body.payout_months || 12,
        do_not_pay_future: 0,
        created_at: now,
        updated_at: now,
      };

      db.prepare(`
        INSERT INTO deals (
          id, bdr_id, client_id, client_name, service_type, proposal_date,
          close_date, first_invoice_date, deal_value, original_deal_value,
          status, is_renewal, original_deal_id, payout_months,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deal.id, deal.bdr_id, deal.client_id, deal.client_name, deal.service_type,
        deal.proposal_date, deal.close_date ?? null, deal.first_invoice_date ?? null,
        deal.deal_value, deal.original_deal_value ?? null, deal.status, deal.is_renewal,
        deal.original_deal_id ?? null, deal.payout_months, deal.created_at, deal.updated_at
      );

      return apiSuccess(deal, 201);
    }

    const supabase = await createClient();
    
    // Auto-calculate first_invoice_date = close_date + 7 days (or proposal_date + 7 days if close_date is null)
    let firstInvoiceDate = body.first_invoice_date || null;
    if (!firstInvoiceDate) {
      const baseDate = body.close_date || body.proposal_date || new Date().toISOString().split('T')[0];
      if (baseDate) {
        const baseDateObj = parseISO(baseDate);
        const calculatedDate = addDays(baseDateObj, 7);
        firstInvoiceDate = format(calculatedDate, 'yyyy-MM-dd');
      }
    }

    const result = await (supabase
      .from('deals')
      .insert({
        ...body,
        bdr_id: bdrId,
        first_invoice_date: firstInvoiceDate,
      })
      .select()
      .single() as any);
    const { data, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data, 201);
  } catch (error: any) {
    return apiError(error.message, 401);
  }
}
