import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin, canAccessBdr } from '@/lib/utils/api-helpers';
import { createRevenueEvent, processRevenueEvent } from '@/lib/commission/revenue-events';
import { parseISO } from 'date-fns';
import { revenueEventSchema } from '@/lib/commission/validators';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const dealId = searchParams.get('deal_id');
    const bdrId = searchParams.get('bdr_id');
    const serviceId = searchParams.get('service_id');
    const status = searchParams.get('status'); // 'collected' or 'scheduled'

    const { isAdmin } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      let query = 'SELECT * FROM revenue_events WHERE 1=1';
      const params: any[] = [];

      if (dealId) {
        query += ' AND deal_id = ?';
        params.push(dealId);
      }

      if (bdrId) {
        if (!isUserAdmin) {
          const { getBdrIdFromUser } = await import('@/lib/utils/auth');
          const userBdrId = await getBdrIdFromUser();
          if (userBdrId !== bdrId) {
            return apiError('Forbidden', 403);
          }
        }
        query += ' AND bdr_id = ?';
        params.push(bdrId);
      } else if (!isUserAdmin) {
        const { getBdrIdFromUser } = await import('@/lib/utils/auth');
        const userBdrId = await getBdrIdFromUser();
        if (!userBdrId) {
          return apiError('BDR profile not found', 404);
        }
        query += ' AND bdr_id = ?';
        params.push(userBdrId);
      }

      if (serviceId) {
        query += ' AND service_id = ?';
        params.push(serviceId);
      }

      if (status === 'collected') {
        query += ' AND collection_date <= date("now")';
      } else if (status === 'scheduled') {
        query += ' AND collection_date > date("now")';
      }

      query += ' ORDER BY collection_date DESC';

      const events = db.prepare(query).all(...params) as any[];

      // Fetch related data
      const eventsWithRelations = events.map(event => {
        const deal = event.deal_id
          ? db.prepare('SELECT client_name, service_type FROM deals WHERE id = ?').get(event.deal_id) as any
          : null;
        const rep = event.bdr_id
          ? db.prepare('SELECT name, email FROM bdr_reps WHERE id = ?').get(event.bdr_id) as any
          : null;
        const service = event.service_id
          ? db.prepare('SELECT service_name FROM deal_services WHERE id = ?').get(event.service_id) as any
          : null;

        return {
          ...event,
          deals: deal,
          bdr_reps: rep,
          deal_services: service,
        };
      });

      return apiSuccess(eventsWithRelations);
    }

    // Supabase mode
    const supabase = await createClient();

    let query: any = (supabase as any)
      .from('revenue_events')
      .select('*, deals(client_name, service_type), bdr_reps(name, email), deal_services(service_name)')
      .order('collection_date', { ascending: false });

    if (dealId) {
      query = query.eq('deal_id', dealId);
    }

    if (bdrId) {
      if (!isUserAdmin) {
        const { getBdrIdFromUser } = await import('@/lib/utils/auth');
        const userBdrId = await getBdrIdFromUser();
        if (userBdrId !== bdrId) {
          return apiError('Forbidden', 403);
        }
      }
      query = query.eq('bdr_id', bdrId);
    } else if (!isUserAdmin) {
      const { getBdrIdFromUser } = await import('@/lib/utils/auth');
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      query = query.eq('bdr_id', userBdrId);
    }

    if (serviceId) {
      query = query.eq('service_id', serviceId);
    }

    if (status === 'collected') {
      const today = new Date().toISOString().split('T')[0];
      query = query.lte('collection_date', today);
    } else if (status === 'scheduled') {
      const today = new Date().toISOString().split('T')[0];
      query = query.gt('collection_date', today);
    }

    const { data, error } = (await query) as { data: any[] | null; error: any };

    if (error) {
      return apiError(error.message || 'Failed to fetch revenue events', 500);
    }

    return apiSuccess(data || []);
  } catch (error: any) {
    return apiError(error.message || 'Unauthorized', 401);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    const body = await request.json();
    
    // Validate input
    const validationResult = revenueEventSchema.safeParse(body);
    if (!validationResult.success) {
      return apiError(
        `Validation error: ${validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        400
      );
    }
    
    const {
      deal_id,
      service_id,
      bdr_id,
      amount_collected,
      collection_date,
      billing_type,
      payment_stage,
      commissionable = true,
    } = validationResult.data;

    const collectionDate = parseISO(collection_date);

    const eventId = await createRevenueEvent(
      deal_id,
      service_id || null,
      bdr_id,
      amount_collected,
      collectionDate,
      billing_type,
      payment_stage,
      commissionable
    );

    // If collection_date is today or in the past, process the event immediately
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (collectionDate <= today) {
      try {
        await processRevenueEvent(eventId);
      } catch (error) {
        console.error('Error processing revenue event:', error);
        // Don't fail the request if processing fails
      }
    }

    return apiSuccess({ id: eventId }, 201);
  } catch (error: any) {
    return apiError(error.message || 'Failed to create revenue event', 500);
  }
}



