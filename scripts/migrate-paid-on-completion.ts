/**
 * Manual migration: Add paid_on_completion to deal_services billing_type constraint.
 * Run with: npx tsx scripts/migrate-paid-on-completion.ts
 *
 * Use this if the automatic migration in local-db.ts failed.
 */

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

if (!USE_LOCAL_DB) {
  console.error('This script only works with local database (USE_LOCAL_DB=true or no Supabase URL)');
  process.exit(1);
}

import { getLocalDB } from '../lib/db/local-db';

try {
  const db = getLocalDB();
  const newTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deal_services_new'").get();
  const oldTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deal_services'").get();
  const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deal_services'").get() as { sql: string } | undefined;

  if (newTableExists && !oldTableExists) {
    // Previous migration dropped old table but didn't rename - complete it
    console.log('Completing partially-applied migration...');
    db.exec(`ALTER TABLE deal_services_new RENAME TO deal_services`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type)`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS update_deal_services_updated_at AFTER UPDATE ON deal_services FOR EACH ROW BEGIN UPDATE deal_services SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);
  } else if (!oldTableExists) {
    console.log('Neither deal_services nor deal_services_new found - nothing to migrate');
  } else if (schemaRow?.sql?.includes("'paid_on_completion'")) {
    console.log('Migration already applied - deal_services already has paid_on_completion');
  } else {
    // Run full migration
    if (newTableExists) db.exec(`DROP TABLE deal_services_new`);

  db.exec(`CREATE TABLE deal_services_new (
    id TEXT PRIMARY KEY,
    deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    service_name TEXT NOT NULL,
    service_type TEXT NOT NULL,
    billing_type TEXT NOT NULL CHECK (billing_type IN ('one_off', 'mrr', 'deposit', 'quarterly', 'paid_on_completion')),
    unit_price REAL NOT NULL,
    monthly_price REAL,
    quarterly_price REAL,
    quantity INTEGER NOT NULL DEFAULT 1,
    contract_months INTEGER NOT NULL DEFAULT 12,
    contract_quarters INTEGER NOT NULL DEFAULT 4,
    commission_rate REAL,
    commissionable_value REAL NOT NULL,
    commission_amount REAL NOT NULL,
    completion_date TEXT,
    is_renewal INTEGER NOT NULL DEFAULT 0,
    original_service_value REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  const oldCols = (db.prepare("PRAGMA table_info(deal_services)").all() as Array<{ name: string }>).map((c) => c.name);
  const newCols = ['id', 'deal_id', 'service_name', 'service_type', 'billing_type', 'unit_price', 'monthly_price', 'quarterly_price', 'quantity', 'contract_months', 'contract_quarters', 'commission_rate', 'commissionable_value', 'commission_amount', 'completion_date', 'is_renewal', 'original_service_value', 'created_at', 'updated_at'];
  const colsToCopy = newCols.filter((c) => oldCols.includes(c));
  console.log('Copying columns:', colsToCopy.join(', '));

  if (colsToCopy.length > 0) {
    const colList = colsToCopy.join(', ');
    db.exec(`INSERT INTO deal_services_new (${colList}) SELECT ${colList} FROM deal_services`);
  }

  db.exec(`DROP TABLE deal_services`);
  db.exec(`ALTER TABLE deal_services_new RENAME TO deal_services`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type)`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS update_deal_services_updated_at AFTER UPDATE ON deal_services FOR EACH ROW BEGIN UPDATE deal_services SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);
  }

  db.pragma('foreign_keys = ON');
  console.log('Migration complete! You can now create deals with Paid on Completion.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
}
