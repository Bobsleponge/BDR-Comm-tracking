import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { clientSchema } from '@/lib/commission/validators';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search');
    
    // Pagination parameters
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
    const offset = (page - 1) * limit;

    if (USE_LOCAL_DB) {
      // Local DB mode - direct SQLite query (much faster)
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      let query = 'SELECT * FROM clients';
      const params: any[] = [];

      if (search) {
        query += ' WHERE name LIKE ? OR company LIKE ? OR email LIKE ?';
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern);
      }

      // Get total count
      let countQuery = 'SELECT COUNT(*) as total FROM clients';
      const countParams: any[] = [];
      
      if (search) {
        countQuery += ' WHERE name LIKE ? OR company LIKE ? OR email LIKE ?';
        const searchPattern = `%${search}%`;
        countParams.push(searchPattern, searchPattern, searchPattern);
      }
      
      const totalResult = db.prepare(countQuery).get(...countParams) as { total: number };
      const total = totalResult?.total || 0;
      
      query += ' ORDER BY name ASC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const clients = db.prepare(query).all(...params) as any[];
      return apiSuccess({
        data: clients,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      }, 200, { cache: 60 }); // Increased cache - clients don't change often
    }

    // Supabase mode
    const supabase = await createClient();
    let query: any = (supabase as any)
      .from('clients')
      .select('*')
      .order('name', { ascending: true });

    if (search) {
      query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%`);
    }

    // Add pagination
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query as { data: any[] | null; error: any; count?: number };

    if (error) {
      console.error('Clients query error:', error);
      if (error.message?.includes('no such table') || error.message?.includes('does not exist')) {
        return apiError('Clients table not found. Please restart the application to initialize the database.', 500);
      }
      return apiError(error.message, 500);
    }

    let total = count;
    if (total === undefined) {
      const countQuery = query.select('id', { count: 'exact', head: true });
      const { count: totalCount } = (await countQuery) as { count: number | null };
      total = totalCount || (data?.length || 0);
    }
    
    return apiSuccess({
      data: data || [],
      pagination: {
        page,
        limit,
        total: total || (data?.length || 0),
        totalPages: Math.ceil((total || (data?.length || 0)) / limit),
      },
    }, 200, { cache: 10 });
  } catch (error: any) {
    console.error('Clients API error:', error);
    if (error.message === 'Unauthorized') {
      return apiError(error.message, 401);
    }
    return apiError(error.message || 'Internal server error', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    const supabase = await createClient();
    const body = await request.json();

    const validated = clientSchema.parse(body);

    const result = await (supabase
      .from('clients')
      .insert(validated)
      .select()
      .single() as any);
    const { data, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data, 201);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return apiError(`Validation error: ${error.errors.map((e: any) => e.message).join(', ')}`, 400);
    }
    return apiError(error.message, 401);
  }
}

