import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { clientUpdateSchema } from '@/lib/commission/validators';

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

      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as any;
      if (!client) {
        return apiError('Client not found', 404);
      }

      return apiSuccess(client);
    }

    const supabase = await createClient();
    const query = (supabase as any)
      .from('clients')
      .select('*')
      .eq('id', id)
      .single();
    const { data, error } = (await query) as { data: any; error: any };

    if (error) {
      return apiError(error.message, 404);
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

    const validated = clientUpdateSchema.parse(body);

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as any;
      if (!existing) {
        return apiError('Client not found', 404);
      }

      const updates: string[] = [];
      const values: any[] = [];

      if (validated.name !== undefined) {
        updates.push('name = ?');
        values.push(validated.name);
      }
      if (validated.company !== undefined) {
        updates.push('company = ?');
        values.push(validated.company);
      }
      if (validated.email !== undefined) {
        updates.push('email = ?');
        values.push(validated.email);
      }
      if (validated.phone !== undefined) {
        updates.push('phone = ?');
        values.push(validated.phone);
      }
      if (validated.address !== undefined) {
        updates.push('address = ?');
        values.push(validated.address);
      }
      if (validated.notes !== undefined) {
        updates.push('notes = ?');
        values.push(validated.notes);
      }

      if (updates.length === 0) {
        return apiSuccess(existing);
      }

      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);

      db.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as any;
      return apiSuccess(client);
    }

    const supabase = await createClient();
    const result = await (supabase
      .from('clients')
      .update(validated)
      .eq('id', id)
      .select()
      .single() as any);
    const { data, error } = result as { data: any; error: any };

    if (error) {
      return apiError(error.message, 500);
    }

    return apiSuccess(data);
  } catch (error: any) {
    if (error?.name === 'ZodError') {
      const issues = error.issues ?? error.errors ?? [];
      return apiError(
        `Validation error: ${issues.map((e: { message: string }) => e.message).join(', ')}`,
        400
      );
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
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as any;
      if (!existing) {
        return apiError('Client not found', 404);
      }

      db.prepare('DELETE FROM clients WHERE id = ?').run(id);
      return apiSuccess({ success: true });
    }

    const supabase = await createClient();
    const result = await (supabase
      .from('clients')
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


