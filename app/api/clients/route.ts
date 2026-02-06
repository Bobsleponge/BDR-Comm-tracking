import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { z } from 'zod';

const clientSchema = z.object({
  name: z.string().min(1, 'Client name is required'),
  company: z.string().optional().nullable(),
  email: z.string().email('Invalid email address').optional().nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search');

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

      query += ' ORDER BY name ASC';

      const clients = db.prepare(query).all(...params) as any[];
      return apiSuccess(clients, 200, { cache: 60 }); // Increased cache - clients don't change often
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

    const { data, error } = await query;

    if (error) {
      console.error('Clients query error:', error);
      if (error.message?.includes('no such table') || error.message?.includes('does not exist')) {
        return apiError('Clients table not found. Please restart the application to initialize the database.', 500);
      }
      return apiError(error.message, 500);
    }

    return apiSuccess(data || [], 200, { cache: 10 });
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

