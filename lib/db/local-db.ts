import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';

let dbInstance: Database.Database | null = null;

export function getLocalDB(): Database.Database {
  try {
    if (dbInstance) {
      return dbInstance;
    }

    const dbPath = process.env.LOCAL_DB_PATH || join(process.cwd(), 'local.db');
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

function seedDefaultLocalUsers(db: Database.Database) {
  db.exec(`
    INSERT OR IGNORE INTO bdr_reps (id, name, email, status, created_at, updated_at)
    VALUES
      ('default-admin-rep', 'Admin User', 'admin@example.com', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('default-test-rep', 'Test BDR', 'test@example.com', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `);
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

  // Commission batch system migration
  try {
    // Create commission_batches if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS commission_batches (
        id TEXT PRIMARY KEY,
        bdr_id TEXT NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
        run_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid')),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_batches_bdr_id ON commission_batches(bdr_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_batches_status ON commission_batches(status);`);

    // Add invoiced_batch_id to commission_entries if not exists
    const ceInfo = db.prepare("PRAGMA table_info(commission_entries)").all() as Array<{ name: string }>;
    const ceColNames = ceInfo.map((c) => c.name);
    if (!ceColNames.includes('invoiced_batch_id')) {
      db.exec(`ALTER TABLE commission_entries ADD COLUMN invoiced_batch_id TEXT REFERENCES commission_batches(id) ON DELETE SET NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_invoiced_batch_id ON commission_entries(invoiced_batch_id);`);
    }

    // Create commission_batch_items if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS commission_batch_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES commission_batches(id) ON DELETE CASCADE,
        commission_entry_id TEXT NOT NULL REFERENCES commission_entries(id) ON DELETE CASCADE,
        override_amount REAL,
        override_payment_date TEXT,
        override_commission_rate REAL,
        adjustment_note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(batch_id, commission_entry_id)
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_batch_items_batch_id ON commission_batch_items(batch_id);`);

    // Add new override columns to existing commission_batch_items
    const cbiInfo = db.prepare("PRAGMA table_info(commission_batch_items)").all() as Array<{ name: string }>;
    const cbiColNames = cbiInfo.map((c) => c.name);
    if (!cbiColNames.includes('override_payment_date')) {
      db.exec(`ALTER TABLE commission_batch_items ADD COLUMN override_payment_date TEXT`);
    }
    if (!cbiColNames.includes('override_commission_rate')) {
      db.exec(`ALTER TABLE commission_batch_items ADD COLUMN override_commission_rate REAL`);
    }

    // Approved commission fingerprints: survives reprocessing (entries deleted = batch_items cascade deleted)
    // When approving, we store fingerprints; eligibility excludes entries matching any fingerprint
    db.exec(`
      CREATE TABLE IF NOT EXISTS approved_commission_fingerprints (
        id TEXT PRIMARY KEY,
        bdr_id TEXT NOT NULL,
        deal_id TEXT NOT NULL,
        effective_date TEXT NOT NULL,
        amount REAL NOT NULL,
        batch_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_acf_bdr_deal_date ON approved_commission_fingerprints(bdr_id, deal_id, effective_date);`);
    // Backfill from existing approved/paid batches (items still present; CASCADE-deleted batches have no data)
    try {
      const { generateUUID } = require('../utils/uuid');
      const rows = db.prepare(`
        SELECT ce.bdr_id, ce.deal_id, ce.payable_date, ce.accrual_date, ce.month, ce.amount, cbi.override_amount, cb.id as batch_id
        FROM commission_batch_items cbi
        JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
        JOIN commission_batches cb ON cbi.batch_id = cb.id
        WHERE cb.status IN ('approved', 'paid')
      `).all() as any[];
      const insertFp = db.prepare(`
        INSERT INTO approved_commission_fingerprints (id, bdr_id, deal_id, effective_date, amount, batch_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const r of rows) {
        const ed = r.payable_date || r.accrual_date || (r.month ? `${r.month}-01` : null);
        const amt = r.override_amount ?? r.amount;
        if (ed != null && amt != null) insertFp.run(generateUUID(), r.bdr_id, r.deal_id, ed, amt, r.batch_id);
      }
    } catch (_) { /* ignore backfill errors */ }

    // Commission batch snapshots: immutable copy at approve time (survives reprocessing CASCADE)
    db.exec(`
      CREATE TABLE IF NOT EXISTS commission_batch_snapshots (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL UNIQUE REFERENCES commission_batches(id) ON DELETE CASCADE,
        snapshot_data TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_batch_snapshots_batch_id ON commission_batch_snapshots(batch_id);`);
  } catch {
    // Ignore migration errors
  }

  // paid_on_completion billing type: SQLite cannot alter CHECK, must recreate deal_services
  try {
    const newTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deal_services_new'").get();
    const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deal_services'").get() as { sql: string } | undefined;
    if (newTableExists && !schemaRow) {
      db.pragma('foreign_keys = OFF');
      db.exec(`ALTER TABLE deal_services_new RENAME TO deal_services`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type)`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS update_deal_services_updated_at AFTER UPDATE ON deal_services FOR EACH ROW BEGIN UPDATE deal_services SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);
      db.pragma('foreign_keys = ON');
    } else if (schemaRow?.sql && !schemaRow.sql.includes("'paid_on_completion'")) {
      db.pragma('foreign_keys = OFF');
      const run = db.transaction(() => {
        db.exec(`DROP TABLE IF EXISTS deal_services_new`);
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
        if (colsToCopy.length > 0) {
          const colList = colsToCopy.join(', ');
          db.exec(`INSERT INTO deal_services_new (${colList}) SELECT ${colList} FROM deal_services`);
        }
        db.exec(`DROP TABLE deal_services`);
        db.exec(`ALTER TABLE deal_services_new RENAME TO deal_services`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type)`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS update_deal_services_updated_at AFTER UPDATE ON deal_services FOR EACH ROW BEGIN UPDATE deal_services SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);
      });
      run();
      db.pragma('foreign_keys = ON');
    }
  } catch {
    db.pragma('foreign_keys = ON');
    // Ignore migration errors
  }

  // percentage_of_net_sales: add billing_percentage, commission_entries.service_id, allow amount NULL
  try {
    const dsInfo = db.prepare("PRAGMA table_info(deal_services)").all() as Array<{ name: string }>;
    if (!dsInfo.map((c) => c.name).includes('billing_percentage')) {
      db.exec(`ALTER TABLE deal_services ADD COLUMN billing_percentage REAL`);
    }
    const ceInfo = db.prepare("PRAGMA table_info(commission_entries)").all() as Array<{ name: string }>;
    const ceCols = ceInfo.map((c) => c.name);
    if (!ceCols.includes('service_id')) {
      db.exec(`ALTER TABLE commission_entries ADD COLUMN service_id TEXT REFERENCES deal_services(id) ON DELETE SET NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_service_id ON commission_entries(service_id)`);
      // Backfill service_id from revenue_events
      db.exec(`
        UPDATE commission_entries 
        SET service_id = (SELECT service_id FROM revenue_events WHERE id = commission_entries.revenue_event_id)
        WHERE revenue_event_id IS NOT NULL AND service_id IS NULL
      `);
    }
    // SQLite: allow NULL amount - need to recreate commission_entries (no ALTER COLUMN for NOT NULL in SQLite)
    const ceTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='commission_entries'").get() as { sql: string } | undefined;
    if (ceTable?.sql?.includes('amount REAL NOT NULL')) {
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE commission_entries_new (
          id TEXT PRIMARY KEY,
          deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          bdr_id TEXT NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
          revenue_event_id TEXT REFERENCES revenue_events(id) ON DELETE SET NULL,
          invoiced_batch_id TEXT REFERENCES commission_batches(id) ON DELETE SET NULL,
          service_id TEXT REFERENCES deal_services(id) ON DELETE SET NULL,
          month TEXT NOT NULL,
          accrual_date TEXT,
          payable_date TEXT,
          amount REAL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('accrued', 'pending', 'payable', 'paid', 'cancelled')),
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(`INSERT INTO commission_entries_new SELECT id, deal_id, bdr_id, revenue_event_id, invoiced_batch_id, service_id, month, accrual_date, payable_date, amount, status, created_at, updated_at FROM commission_entries`);
      db.exec(`DROP TABLE commission_entries`);
      db.exec(`ALTER TABLE commission_entries_new RENAME TO commission_entries`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ce_deal_month_null_svc ON commission_entries(deal_id, month) WHERE service_id IS NULL`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ce_deal_month_svc ON commission_entries(deal_id, month, service_id) WHERE service_id IS NOT NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_service_id ON commission_entries(service_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_bdr_id ON commission_entries(bdr_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_deal_id ON commission_entries(deal_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_month ON commission_entries(month)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_status ON commission_entries(status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_revenue_event_id ON commission_entries(revenue_event_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_invoiced_batch_id ON commission_entries(invoiced_batch_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_accrual_date ON commission_entries(accrual_date)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_commission_entries_payable_date ON commission_entries(payable_date)`);
      db.pragma('foreign_keys = ON');
    }
    // Add percentage_of_net_sales to deal_services billing_type
    const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deal_services'").get() as { sql: string } | undefined;
    if (schemaRow?.sql && !schemaRow.sql.includes("'percentage_of_net_sales'")) {
      db.pragma('foreign_keys = OFF');
      db.exec(`DROP TABLE IF EXISTS deal_services_pons`);
      db.exec(`
        CREATE TABLE deal_services_pons (
          id TEXT PRIMARY KEY,
          deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
          service_name TEXT NOT NULL,
          service_type TEXT NOT NULL,
          billing_type TEXT NOT NULL CHECK (billing_type IN ('one_off', 'mrr', 'deposit', 'quarterly', 'paid_on_completion', 'percentage_of_net_sales')),
          unit_price REAL NOT NULL,
          monthly_price REAL,
          quarterly_price REAL,
          quantity INTEGER NOT NULL DEFAULT 1,
          contract_months INTEGER NOT NULL DEFAULT 12,
          contract_quarters INTEGER NOT NULL DEFAULT 4,
          commission_rate REAL,
          billing_percentage REAL,
          commissionable_value REAL NOT NULL,
          commission_amount REAL NOT NULL,
          completion_date TEXT,
          is_renewal INTEGER NOT NULL DEFAULT 0,
          original_service_value REAL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const oldCols = (db.prepare("PRAGMA table_info(deal_services)").all() as Array<{ name: string }>).map((c) => c.name);
      const newCols = ['id', 'deal_id', 'service_name', 'service_type', 'billing_type', 'unit_price', 'monthly_price', 'quarterly_price', 'quantity', 'contract_months', 'contract_quarters', 'commission_rate', 'billing_percentage', 'commissionable_value', 'commission_amount', 'completion_date', 'is_renewal', 'original_service_value', 'created_at', 'updated_at'];
      const colsToCopy = newCols.filter((c) => oldCols.includes(c));
      if (colsToCopy.length > 0) {
        db.exec(`INSERT INTO deal_services_pons (${colsToCopy.join(', ')}) SELECT ${colsToCopy.join(', ')} FROM deal_services`);
      }
      db.exec(`DROP TABLE deal_services`);
      db.exec(`ALTER TABLE deal_services_pons RENAME TO deal_services`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type)`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS update_deal_services_updated_at AFTER UPDATE ON deal_services FOR EACH ROW BEGIN UPDATE deal_services SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);
      db.pragma('foreign_keys = ON');
    }
  } catch {
    db.pragma('foreign_keys = ON');
  }

  // Ensure default local auth users exist for quick login paths.
  try {
    seedDefaultLocalUsers(db);
  } catch {
    // Ignore seed errors
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

  // Seed built-in local users expected by quick-login in UI/docs.
  seedDefaultLocalUsers(db);

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
      billing_type TEXT NOT NULL CHECK (billing_type IN ('one_off', 'mrr', 'deposit', 'quarterly', 'paid_on_completion', 'percentage_of_net_sales')),
      unit_price REAL NOT NULL,
      monthly_price REAL,
      quarterly_price REAL,
      quantity INTEGER NOT NULL DEFAULT 1,
      contract_months INTEGER NOT NULL DEFAULT 12,
      contract_quarters INTEGER NOT NULL DEFAULT 4,
      commission_rate REAL,
      billing_percentage REAL,
      commissionable_value REAL NOT NULL,
      commission_amount REAL NOT NULL,
      completion_date TEXT,
      is_renewal INTEGER NOT NULL DEFAULT 0,
      original_service_value REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create commission_batches table (before commission_entries for invoiced_batch_id FK)
  db.exec(`
    CREATE TABLE IF NOT EXISTS commission_batches (
      id TEXT PRIMARY KEY,
      bdr_id TEXT NOT NULL REFERENCES bdr_reps(id) ON DELETE CASCADE,
      run_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid')),
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
      invoiced_batch_id TEXT REFERENCES commission_batches(id) ON DELETE SET NULL,
      service_id TEXT REFERENCES deal_services(id) ON DELETE SET NULL,
      month TEXT NOT NULL,
      accrual_date TEXT,
      payable_date TEXT,
      amount REAL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('accrued', 'pending', 'payable', 'paid', 'cancelled')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ce_deal_month_null_svc ON commission_entries(deal_id, month) WHERE service_id IS NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ce_deal_month_svc ON commission_entries(deal_id, month, service_id) WHERE service_id IS NOT NULL`);

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

  // Create commission_batch_items table
  db.exec(`
    CREATE TABLE IF NOT EXISTS commission_batch_items (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES commission_batches(id) ON DELETE CASCADE,
      commission_entry_id TEXT NOT NULL REFERENCES commission_entries(id) ON DELETE CASCADE,
      override_amount REAL,
      override_payment_date TEXT,
      override_commission_rate REAL,
      adjustment_note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(batch_id, commission_entry_id)
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
    CREATE INDEX IF NOT EXISTS idx_commission_entries_invoiced_batch_id ON commission_entries(invoiced_batch_id);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_accrual_date ON commission_entries(accrual_date);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_payable_date ON commission_entries(payable_date);
    CREATE INDEX IF NOT EXISTS idx_commission_batches_bdr_id ON commission_batches(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_commission_batches_status ON commission_batches(status);
    CREATE INDEX IF NOT EXISTS idx_commission_batch_items_batch_id ON commission_batch_items(batch_id);
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

    CREATE TRIGGER IF NOT EXISTS update_commission_batches_updated_at 
      AFTER UPDATE ON commission_batches
      FOR EACH ROW
      BEGIN
        UPDATE commission_batches SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS update_commission_batch_items_updated_at 
      AFTER UPDATE ON commission_batch_items
      FOR EACH ROW
      BEGIN
        UPDATE commission_batch_items SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
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
