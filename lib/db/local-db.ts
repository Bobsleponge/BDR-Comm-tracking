import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';

let dbInstance: Database.Database | null = null;

export function getLocalDB(): Database.Database {
  try {
    if (dbInstance) {
      return dbInstance;
    }

    const dbPath = join(process.cwd(), 'local.db');
    const isNewDb = !existsSync(dbPath);
    
    dbInstance = new Database(dbPath);
    
    // Enable foreign keys
    dbInstance.pragma('foreign_keys = ON');
    
    // Initialize schema if this is a new database
    if (isNewDb) {
      initializeSchema(dbInstance);
    } else {
      // Run migrations for existing databases
      migrateSchema(dbInstance);
    }
    
    return dbInstance;
  } catch (error: any) {
    throw error;
  }
}

function migrateSchema(db: Database.Database) {
  // Add missing columns to deal_services for existing DBs
  const tableInfo = db.prepare("PRAGMA table_info(deal_services)").all() as Array<{ name: string }>;
  const colNames = tableInfo.map((c) => c.name);
  try {
    if (!colNames.includes('service_type')) {
      db.exec(`ALTER TABLE deal_services ADD COLUMN service_type TEXT NOT NULL DEFAULT ''`);
      db.exec(`UPDATE deal_services SET service_type = 'Service' WHERE service_type = '' OR service_type IS NULL`);
    }
    if (!colNames.includes('is_renewal')) {
      db.exec(`ALTER TABLE deal_services ADD COLUMN is_renewal INTEGER NOT NULL DEFAULT 0`);
    }
    if (!colNames.includes('original_service_value')) {
      db.exec(`ALTER TABLE deal_services ADD COLUMN original_service_value REAL`);
    }
  } catch {
    // Ignore migration errors
  }
}

function initializeSchema(db: Database.Database) {
  // Create bdr_reps table
  db.exec(`
    CREATE TABLE IF NOT EXISTS bdr_reps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      allow_trailing_commission INTEGER NOT NULL DEFAULT 0,
      leave_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create commission_rules table
  db.exec(`
    CREATE TABLE IF NOT EXISTS commission_rules (
      id TEXT PRIMARY KEY,
      base_rate REAL NOT NULL DEFAULT 0.025,
      quarterly_bonus_rate REAL NOT NULL DEFAULT 0.025,
      renewal_rate REAL NOT NULL DEFAULT 0.01,
      payout_months_default INTEGER NOT NULL DEFAULT 12,
      payout_delay_days INTEGER NOT NULL DEFAULT 30,
      tier_1_threshold REAL,
      tier_1_rate REAL,
      tier_2_rate REAL,
      quarterly_target REAL,
      clawback_days INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    );
  `);

  // Create service_pricing table
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_pricing (
      id TEXT PRIMARY KEY,
      service_type TEXT NOT NULL UNIQUE,
      commission_percent REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create clients table
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create deals table
  db.exec(`
    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      bdr_id TEXT NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      client_name TEXT NOT NULL,
      service_type TEXT NOT NULL,
      proposal_date TEXT NOT NULL,
      close_date TEXT,
      first_invoice_date TEXT,
      deal_value REAL NOT NULL,
      original_deal_value REAL,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'closed-won', 'closed-lost')),
      is_renewal INTEGER NOT NULL DEFAULT 0,
      original_deal_id TEXT REFERENCES deals(id),
      cancellation_date TEXT,
      payout_months INTEGER NOT NULL DEFAULT 12,
      do_not_pay_future INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create deal_services table
  db.exec(`
    CREATE TABLE IF NOT EXISTS deal_services (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      service_name TEXT NOT NULL,
      service_type TEXT NOT NULL,
      billing_type TEXT NOT NULL CHECK (billing_type IN ('one_off', 'mrr', 'deposit', 'quarterly')),
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
    );
  `);

  // Create commission_entries table
  db.exec(`
    CREATE TABLE IF NOT EXISTS commission_entries (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      bdr_id TEXT NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
      revenue_event_id TEXT REFERENCES revenue_events(id) ON DELETE SET NULL,
      month TEXT NOT NULL,
      accrual_date TEXT,
      payable_date TEXT,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('accrued', 'pending', 'payable', 'paid', 'cancelled')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(deal_id, month)
    );
  `);

  // Create quarterly_targets table
  db.exec(`
    CREATE TABLE IF NOT EXISTS quarterly_targets (
      id TEXT PRIMARY KEY,
      bdr_id TEXT NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
      quarter TEXT NOT NULL,
      target_revenue REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bdr_id, quarter)
    );
  `);

  // Create quarterly_performance table
  db.exec(`
    CREATE TABLE IF NOT EXISTS quarterly_performance (
      id TEXT PRIMARY KEY,
      bdr_id TEXT NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
      quarter TEXT NOT NULL,
      revenue_collected REAL NOT NULL DEFAULT 0,
      achieved_percent REAL NOT NULL DEFAULT 0,
      bonus_eligible INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bdr_id, quarter)
    );
  `);

  // Create revenue_events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS revenue_events (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      service_id TEXT REFERENCES deal_services(id) ON DELETE SET NULL,
      bdr_id TEXT NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
      amount_collected REAL NOT NULL,
      collection_date TEXT NOT NULL,
      billing_type TEXT NOT NULL CHECK (billing_type IN ('one_off', 'monthly', 'quarterly', 'renewal')),
      payment_stage TEXT NOT NULL CHECK (payment_stage IN ('invoice', 'completion', 'renewal', 'scheduled')),
      commissionable INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_deals_bdr_id ON deals(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
    CREATE INDEX IF NOT EXISTS idx_deals_client_id ON deals(client_id);
    CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_bdr_id ON commission_entries(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_deal_id ON commission_entries(deal_id);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_month ON commission_entries(month);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_status ON commission_entries(status);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_revenue_event_id ON commission_entries(revenue_event_id);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_accrual_date ON commission_entries(accrual_date);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_payable_date ON commission_entries(payable_date);
    CREATE INDEX IF NOT EXISTS idx_quarterly_targets_bdr_id ON quarterly_targets(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_quarterly_performance_bdr_id ON quarterly_performance(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id);
    CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_deal_id ON revenue_events(deal_id);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_service_id ON revenue_events(service_id);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_bdr_id ON revenue_events(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_collection_date ON revenue_events(collection_date);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_billing_type ON revenue_events(billing_type);
  `);

  // Create triggers for updated_at (SQLite syntax)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS update_bdr_reps_updated_at 
      AFTER UPDATE ON bdr_reps
      FOR EACH ROW
      BEGIN
        UPDATE bdr_reps SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_deals_updated_at 
      AFTER UPDATE ON deals
      FOR EACH ROW
      BEGIN
        UPDATE deals SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_commission_entries_updated_at 
      AFTER UPDATE ON commission_entries
      FOR EACH ROW
      BEGIN
        UPDATE commission_entries SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_commission_rules_updated_at 
      AFTER UPDATE ON commission_rules
      FOR EACH ROW
      BEGIN
        UPDATE commission_rules SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_quarterly_targets_updated_at 
      AFTER UPDATE ON quarterly_targets
      FOR EACH ROW
      BEGIN
        UPDATE quarterly_targets SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_quarterly_performance_updated_at 
      AFTER UPDATE ON quarterly_performance
      FOR EACH ROW
      BEGIN
        UPDATE quarterly_performance SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_service_pricing_updated_at 
      AFTER UPDATE ON service_pricing
      FOR EACH ROW
      BEGIN
        UPDATE service_pricing SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_clients_updated_at 
      AFTER UPDATE ON clients
      FOR EACH ROW
      BEGIN
        UPDATE clients SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_deal_services_updated_at 
      AFTER UPDATE ON deal_services
      FOR EACH ROW
      BEGIN
        UPDATE deal_services SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_revenue_events_updated_at 
      AFTER UPDATE ON revenue_events
      FOR EACH ROW
      BEGIN
        UPDATE revenue_events SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
  `);

  // Insert default commission rules
  db.exec(`
    INSERT OR IGNORE INTO commission_rules (
      id, base_rate, quarterly_bonus_rate, renewal_rate, 
      payout_months_default, payout_delay_days,
      tier_1_threshold, tier_1_rate, tier_2_rate, 
      quarterly_target, clawback_days
    )
    VALUES (
      'default-rule', 0.025, 0.025, 0.01, 
      12, 30,
      250000.00, 0.025, 0.05, 
      75000.00, 90
    );
  `);
}
