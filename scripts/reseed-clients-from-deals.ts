import { getLocalDB } from '../lib/db/local-db';
import { generateUUID } from '../lib/utils/uuid';

const db = getLocalDB();

console.log('Reseeding clients from deals (local DB)...\n');

// 1. Clear client_id on all deals first (avoids FK constraint when deleting clients)
const clearResult = db.prepare('UPDATE deals SET client_id = NULL').run();
console.log(`Cleared client_id from ${clearResult.changes} deals`);

// 2. Delete all existing clients
const deleteResult = db.prepare('DELETE FROM clients').run();
console.log(`Deleted ${deleteResult.changes} existing clients`);

// 3. Get all deals with client_name
const deals = db.prepare(`
  SELECT id, client_name FROM deals
  WHERE TRIM(client_name) != ''
`).all() as Array<{ id: string; client_name: string }>;

// 4. Build unique clients (normalized by lower name)
const nameToClientId = new Map<string, string>();
const clientsToCreate: Array<{ name: string; normalized: string }> = [];

for (const d of deals) {
  const trimmed = d.client_name.trim();
  const normalized = trimmed.toLowerCase();
  if (!nameToClientId.has(normalized)) {
    nameToClientId.set(normalized, '');
    clientsToCreate.push({ name: trimmed, normalized });
  }
}

const now = new Date().toISOString();

// 5. Create one client per unique name
for (const { name, normalized } of clientsToCreate) {
  const clientId = generateUUID();
  db.prepare(`
    INSERT INTO clients (id, name, company, email, phone, address, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clientId, name, null, null, null, null, null, now, now);
  nameToClientId.set(normalized, clientId);
}

// 6. Update all deals with new client_id
const updateStmt = db.prepare('UPDATE deals SET client_id = ? WHERE id = ?');
let updated = 0;
for (const d of deals) {
  const normalized = d.client_name.trim().toLowerCase();
  const clientId = nameToClientId.get(normalized);
  if (clientId) {
    updateStmt.run(clientId, d.id);
    updated++;
  }
}

console.log(`Created ${clientsToCreate.length} clients`);
console.log(`Updated ${updated} deals with client associations`);
console.log('\nDone!');
