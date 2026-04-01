import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, requireAdmin } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function POST(request: NextRequest) {
  try {
    await requireAuth();
    await requireAdmin();

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const { generateUUID } = await import('@/lib/utils/uuid');
      const db = getLocalDB();

      // 1. Clear client_id on all deals first (avoids FK constraint when deleting clients)
      db.prepare('UPDATE deals SET client_id = NULL').run();
      // 2. Delete all existing clients
      db.prepare('DELETE FROM clients').run();

      // 3. Get distinct client_name from deals (group by normalized key to avoid duplicates)
      const deals = db.prepare(`
        SELECT id, client_name FROM deals
        WHERE TRIM(client_name) != ''
      `).all() as Array<{ id: string; client_name: string }>;

      // Build map: normalized_name -> client_id (first occurrence wins for display)
      const nameToClientId = new Map<string, string>();
      const clientsToCreate: Array<{ name: string; normalized: string }> = [];

      for (const d of deals) {
        const trimmed = d.client_name.trim();
        const normalized = trimmed.toLowerCase();
        if (!nameToClientId.has(normalized)) {
          nameToClientId.set(normalized, ''); // placeholder, will fill when we create
          clientsToCreate.push({ name: trimmed, normalized });
        }
      }

      const now = new Date().toISOString();

      // 4. Create one client per unique name
      for (const { name, normalized } of clientsToCreate) {
        const clientId = generateUUID();
        db.prepare(`
          INSERT INTO clients (id, name, company, email, phone, address, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(clientId, name, null, null, null, null, null, now, now);
        nameToClientId.set(normalized, clientId);
      }

      // 5. Update all deals with new client_id
      const updateStmt = db.prepare('UPDATE deals SET client_id = ? WHERE id = ?');
      for (const d of deals) {
        const normalized = d.client_name.trim().toLowerCase();
        const clientId = nameToClientId.get(normalized);
        if (clientId) {
          updateStmt.run(clientId, d.id);
        }
      }

      return apiSuccess({
        success: true,
        clientsCreated: clientsToCreate.length,
        dealsUpdated: deals.length,
      }, 200);
    }

    // Supabase mode
    const supabase = await createClient();

    // 1. Fetch all client IDs and delete
    const { data: existingClients } = await supabase.from('clients').select('id');
    if (existingClients && existingClients.length > 0) {
      const ids = existingClients.map((c: any) => c.id);
      const { error: deleteError } = await supabase.from('clients').delete().in('id', ids);
      if (deleteError) {
        console.error('Reseed delete error:', deleteError);
        return apiError(deleteError.message, 500);
      }
    }

    // 2. Get all deals with client_name
    const { data: dealsData, error: dealsError } = await supabase
      .from('deals')
      .select('id, client_name');
    if (dealsError) return apiError(dealsError.message, 500);
    const deals = (dealsData || []).filter((d: any) => d.client_name && d.client_name.trim() !== '');

    // 3. Build unique clients (normalized by lower name)
    const nameToClientId = new Map<string, string>();
    const clientsToCreate: Array<{ name: string; normalized: string }> = [];

    for (const d of deals) {
      const trimmed = (d.client_name as string).trim();
      const normalized = trimmed.toLowerCase();
      if (!nameToClientId.has(normalized)) {
        nameToClientId.set(normalized, '');
        clientsToCreate.push({ name: trimmed, normalized });
      }
    }

    if (clientsToCreate.length === 0) {
      return apiSuccess({
        success: true,
        clientsCreated: 0,
        dealsUpdated: 0,
      }, 200);
    }

    // 4. Insert clients
    const insertRows = clientsToCreate.map(({ name }) => ({
      name,
      company: null,
      email: null,
      phone: null,
      address: null,
      notes: null,
    }));

    const { data: insertedClients, error: insertError } = await supabase
      .from('clients')
      .insert(insertRows)
      .select('id, name');
    if (insertError) return apiError(insertError.message, 500);

    const inserted = insertedClients || [];
    for (let i = 0; i < clientsToCreate.length; i++) {
      const { normalized } = clientsToCreate[i];
      const client = inserted[i];
      if (client) nameToClientId.set(normalized, client.id);
    }

    // 5. Update deals
    let updated = 0;
    for (const d of deals) {
      const normalized = (d.client_name as string).trim().toLowerCase();
      const clientId = nameToClientId.get(normalized);
      if (clientId) {
        const { error: updateError } = await supabase
          .from('deals')
          .update({ client_id: clientId })
          .eq('id', d.id);
        if (!updateError) updated++;
      }
    }

    return apiSuccess({
      success: true,
      clientsCreated: clientsToCreate.length,
      dealsUpdated: updated,
    }, 200);
  } catch (error: any) {
    console.error('Reseed clients error:', error);
    if (error.message === 'Unauthorized') {
      return apiError(error.message, 401);
    }
    if (error.message === 'Forbidden: Admin access required') {
      return apiError(error.message, 403);
    }
    return apiError(error.message || 'Internal server error', 500);
  }
}
