import Database from 'better-sqlite3';
import { join } from 'path';
import { readFileSync } from 'fs';
import { monitorQuery } from './performance-monitor';

const dbPath = join(process.cwd(), 'local.db');
let db: Database.Database | null = null;
let isInitialized = false;

export function getLocalDB(): Database.Database {
  if (!db) {
    const start = Date.now();
    try {
      db = new Database(dbPath, {
        // Add timeout to prevent indefinite blocking
        timeout: 30000, // 30 second timeout
        // Enable verbose error messages in dev
        verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
      });
      
      // Optimize SQLite settings for performance
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL'); // Faster than FULL, still safe with WAL
      db.pragma('cache_size = -64000'); // 64MB cache
      db.pragma('temp_store = MEMORY'); // Store temp tables in memory
      db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
      db.pragma('busy_timeout = 30000'); // Wait up to 30s if database is locked
      db.pragma('optimize'); // Run query optimizer
      
      const initStart = Date.now();
      initializeDatabase(db);
      const initDuration = Date.now() - initStart;
      const totalDuration = Date.now() - start;
      
      if (process.env.NODE_ENV === 'development') {
        console.log(`[DB] Database initialized in ${initDuration}ms (total: ${totalDuration}ms)`);
      }
      
      isInitialized = true;
    } catch (error: any) {
      console.error('[DB] Failed to initialize database:', error.message);
      throw error;
    }
  }
  return db;
}

/**
 * Wrapper for prepared statements that monitors performance
 */
export function prepareWithMonitoring(db: Database.Database, query: string) {
  const stmt = db.prepare(query);
  
  // Wrap the statement methods to monitor performance
  const originalAll = stmt.all.bind(stmt);
  const originalGet = stmt.get.bind(stmt);
  const originalRun = stmt.run.bind(stmt);
  
  stmt.all = function(...args: any[]) {
    return monitorQuery(query, () => originalAll(...args), args);
  };
  
  stmt.get = function(...args: any[]) {
    return monitorQuery(query, () => originalGet(...args), args);
  };
  
  stmt.run = function(...args: any[]) {
    return monitorQuery(query, () => originalRun(...args), args);
  };
  
  return stmt;
}

function initializeDatabase(db: Database.Database) {
  // Quick check: if all expected tables exist, skip migration checks
  const expectedTables = ['clients', 'bdr_reps', 'deals', 'deal_services', 'commission_rules', 
    'commission_entries', 'revenue_events', 'quarterly_targets', 'quarterly_performance'];
  
  const tables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all() as { name: string }[];

  const tableNames = tables.map(t => t.name);
  const hasAllTables = expectedTables.every(table => tableNames.includes(table));
  
  // If all tables exist, skip migration checks (much faster)
  if (hasAllTables) {
    // Just ensure indexes exist (fast operation)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
      CREATE INDEX IF NOT EXISTS idx_deals_bdr_id ON deals(bdr_id);
      CREATE INDEX IF NOT EXISTS idx_deals_client_id ON deals(client_id);
      CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
      CREATE INDEX IF NOT EXISTS idx_deals_cancellation_date ON deals(cancellation_date);
      CREATE INDEX IF NOT EXISTS idx_deals_first_invoice_date ON deals(first_invoice_date);
      CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id);
      CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type);
      CREATE INDEX IF NOT EXISTS idx_commission_entries_bdr_id ON commission_entries(bdr_id);
      CREATE INDEX IF NOT EXISTS idx_commission_entries_deal_id ON commission_entries(deal_id);
      CREATE INDEX IF NOT EXISTS idx_commission_entries_month ON commission_entries(month);
      CREATE INDEX IF NOT EXISTS idx_commission_entries_status ON commission_entries(status);
      CREATE INDEX IF NOT EXISTS idx_commission_entries_revenue_event_id ON commission_entries(revenue_event_id);
      CREATE INDEX IF NOT EXISTS idx_commission_entries_accrual_date ON commission_entries(accrual_date);
      CREATE INDEX IF NOT EXISTS idx_commission_entries_payable_date ON commission_entries(payable_date);
      CREATE INDEX IF NOT EXISTS idx_revenue_events_deal_id ON revenue_events(deal_id);
      CREATE INDEX IF NOT EXISTS idx_revenue_events_service_id ON revenue_events(service_id);
      CREATE INDEX IF NOT EXISTS idx_revenue_events_bdr_id ON revenue_events(bdr_id);
      CREATE INDEX IF NOT EXISTS idx_revenue_events_collection_date ON revenue_events(collection_date);
      CREATE INDEX IF NOT EXISTS idx_revenue_events_billing_type ON revenue_events(billing_type);
      CREATE INDEX IF NOT EXISTS idx_revenue_events_payment_stage ON revenue_events(payment_stage);
      CREATE INDEX IF NOT EXISTS idx_quarterly_targets_bdr_id ON quarterly_targets(bdr_id);
      CREATE INDEX IF NOT EXISTS idx_quarterly_performance_bdr_id ON quarterly_performance(bdr_id);
    `);
    return; // Skip all migration checks
  }

  const hasClientsTable = tableNames.includes('clients');
  const hasDealsTable = tableNames.includes('deals');
  const hasDealServicesTable = tableNames.includes('deal_services');
  
  // If database exists, check for missing tables and columns
  if (tables.length > 0) {
    // Add clients table if missing
    if (!hasClientsTable) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS clients (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          company TEXT,
          email TEXT,
          phone TEXT,
          address TEXT,
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
      `);
      if (process.env.NODE_ENV === 'development') {
        console.log('Added clients table to existing database');
      }
    }
    
    // Add deal_services table if missing
    if (!hasDealServicesTable) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS deal_services (
          id TEXT PRIMARY KEY,
          deal_id TEXT NOT NULL,
          service_name TEXT NOT NULL,
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
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id);
        CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type);
      `);
      if (process.env.NODE_ENV === 'development') {
        console.log('Added deal_services table to existing database');
      }
    }
    
    // Add missing columns to commission_rules table
    const hasCommissionRulesTable = tableNames.includes('commission_rules');
    if (hasCommissionRulesTable) {
      const commissionRulesColumns = ['tier_1_threshold', 'tier_1_rate', 'tier_2_rate', 'quarterly_target', 'clawback_days', 'payout_delay_days'];
      for (const col of commissionRulesColumns) {
        try {
          db.prepare(`SELECT ${col} FROM commission_rules LIMIT 1`).get();
        } catch (error: any) {
          if (error.message.includes('no such column')) {
            let alterSql = '';
            if (col === 'tier_1_threshold' || col === 'quarterly_target') {
              alterSql = `ALTER TABLE commission_rules ADD COLUMN ${col} REAL DEFAULT ${col === 'tier_1_threshold' ? '250000.00' : '75000.00'};`;
            } else if (col === 'tier_1_rate' || col === 'tier_2_rate') {
              alterSql = `ALTER TABLE commission_rules ADD COLUMN ${col} REAL DEFAULT ${col === 'tier_1_rate' ? '0.025' : '0.05'};`;
            } else if (col === 'clawback_days' || col === 'payout_delay_days') {
              alterSql = `ALTER TABLE commission_rules ADD COLUMN ${col} INTEGER DEFAULT ${col === 'payout_delay_days' ? '30' : '90'};`;
            }
            if (alterSql) {
              db.exec(alterSql);
              if (process.env.NODE_ENV === 'development') {
                console.log(`Added ${col} column to commission_rules table`);
              }
            }
          }
        }
      }
    }

    // Add missing columns to bdr_reps table
    const hasBdrRepsTable = tableNames.includes('bdr_reps');
    if (hasBdrRepsTable) {
      const bdrRepsColumns = ['allow_trailing_commission', 'leave_date'];
      for (const col of bdrRepsColumns) {
        try {
          db.prepare(`SELECT ${col} FROM bdr_reps LIMIT 1`).get();
        } catch (error: any) {
          if (error.message.includes('no such column')) {
            if (col === 'allow_trailing_commission') {
              db.exec(`ALTER TABLE bdr_reps ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0;`);
            } else if (col === 'leave_date') {
              db.exec(`ALTER TABLE bdr_reps ADD COLUMN ${col} TEXT;`);
            }
            if (process.env.NODE_ENV === 'development') {
              console.log(`Added ${col} column to bdr_reps table`);
            }
          }
        }
      }
    }

    // Add missing columns to commission_entries table
    const hasCommissionEntriesTable = tableNames.includes('commission_entries');
    if (hasCommissionEntriesTable) {
      const commissionEntriesColumns = ['revenue_event_id', 'accrual_date', 'payable_date'];
      for (const col of commissionEntriesColumns) {
        try {
          db.prepare(`SELECT ${col} FROM commission_entries LIMIT 1`).get();
        } catch (error: any) {
          if (error.message.includes('no such column')) {
            db.exec(`ALTER TABLE commission_entries ADD COLUMN ${col} TEXT;`);
            if (process.env.NODE_ENV === 'development') {
              console.log(`Added ${col} column to commission_entries table`);
            }
          }
        }
      }
    }

    // Create revenue_events table if it doesn't exist
    const hasRevenueEventsTable = tableNames.includes('revenue_events');
    if (!hasRevenueEventsTable) {
      db.exec(`
    CREATE TABLE IF NOT EXISTS revenue_events (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      service_id TEXT,
      bdr_id TEXT NOT NULL,
      amount_collected REAL NOT NULL,
      collection_date TEXT NOT NULL,
      billing_type TEXT NOT NULL CHECK (billing_type IN ('one_off', 'monthly', 'quarterly', 'renewal')),
      payment_stage TEXT NOT NULL CHECK (payment_stage IN ('invoice', 'completion', 'renewal', 'scheduled')),
      commissionable INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES deal_services(id) ON DELETE SET NULL,
      FOREIGN KEY (bdr_id) REFERENCES bdr_reps(id) ON DELETE CASCADE
    );

        CREATE INDEX IF NOT EXISTS idx_revenue_events_deal_id ON revenue_events(deal_id);
        CREATE INDEX IF NOT EXISTS idx_revenue_events_service_id ON revenue_events(service_id);
        CREATE INDEX IF NOT EXISTS idx_revenue_events_bdr_id ON revenue_events(bdr_id);
        CREATE INDEX IF NOT EXISTS idx_revenue_events_collection_date ON revenue_events(collection_date);
        CREATE INDEX IF NOT EXISTS idx_revenue_events_billing_type ON revenue_events(billing_type);
        CREATE INDEX IF NOT EXISTS idx_commission_entries_revenue_event_id ON commission_entries(revenue_event_id);
        CREATE INDEX IF NOT EXISTS idx_commission_entries_accrual_date ON commission_entries(accrual_date);
        CREATE INDEX IF NOT EXISTS idx_commission_entries_payable_date ON commission_entries(payable_date);
      `);
      if (process.env.NODE_ENV === 'development') {
        console.log('Added revenue_events table to existing database');
      }
    }
    
    // Add client_id column to deals table if missing
    if (hasDealsTable) {
      try {
        // Check if client_id column exists by trying to query it
        db.prepare('SELECT client_id FROM deals LIMIT 1').get();
      } catch (error: any) {
        // Column doesn't exist, add it
        if (error.message.includes('no such column')) {
          db.exec(`
            ALTER TABLE deals ADD COLUMN client_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_deals_client_id ON deals(client_id);
            CREATE INDEX IF NOT EXISTS idx_deals_cancellation_date ON deals(cancellation_date);
            CREATE INDEX IF NOT EXISTS idx_deals_first_invoice_date ON deals(first_invoice_date);
          `);
          if (process.env.NODE_ENV === 'development') {
            console.log('Added client_id column to deals table');
          }
        }
      }
      
      // Add original_deal_value column to deals table if missing
      try {
        db.prepare('SELECT original_deal_value FROM deals LIMIT 1').get();
      } catch (error: any) {
        if (error.message.includes('no such column')) {
          db.exec(`
            ALTER TABLE deals ADD COLUMN original_deal_value REAL;
          `);
          if (process.env.NODE_ENV === 'development') {
            console.log('Added original_deal_value column to deals table');
          }
        }
      }
    }
    
    // Don't return early - always run the full table creation to ensure all tables exist
  }

  // Create tables
  db.exec(`
    -- Enable UUID extension simulation
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bdr_reps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      allow_trailing_commission INTEGER NOT NULL DEFAULT 0,
      leave_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS commission_rules (
      id TEXT PRIMARY KEY,
      base_rate REAL NOT NULL DEFAULT 0.025,
      quarterly_bonus_rate REAL NOT NULL DEFAULT 0.025,
      renewal_rate REAL NOT NULL DEFAULT 0.01,
      payout_months_default INTEGER NOT NULL DEFAULT 12,
      payout_delay_days INTEGER NOT NULL DEFAULT 30,
      tier_1_threshold REAL DEFAULT 250000.00,
      tier_1_rate REAL DEFAULT 0.025,
      tier_2_rate REAL DEFAULT 0.05,
      quarterly_target REAL DEFAULT 75000.00,
      clawback_days INTEGER DEFAULT 90,
      updated_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS service_pricing (
      id TEXT PRIMARY KEY,
      service_type TEXT NOT NULL UNIQUE,
      commission_percent REAL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      bdr_id TEXT NOT NULL,
      client_id TEXT,
      client_name TEXT NOT NULL,
      service_type TEXT NOT NULL,
      proposal_date TEXT NOT NULL,
      close_date TEXT,
      first_invoice_date TEXT,
      deal_value REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'closed-won', 'closed-lost')),
      is_renewal INTEGER NOT NULL DEFAULT 0,
      original_deal_id TEXT,
      original_deal_value REAL,
      cancellation_date TEXT,
      payout_months INTEGER NOT NULL DEFAULT 12,
      do_not_pay_future INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (bdr_id) REFERENCES bdr_reps(id),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );

    CREATE TABLE IF NOT EXISTS deal_services (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS revenue_events (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      service_id TEXT,
      bdr_id TEXT NOT NULL,
      amount_collected REAL NOT NULL,
      collection_date TEXT NOT NULL,
      billing_type TEXT NOT NULL CHECK (billing_type IN ('one_off', 'monthly', 'quarterly', 'renewal')),
      payment_stage TEXT NOT NULL CHECK (payment_stage IN ('invoice', 'completion', 'renewal', 'scheduled')),
      commissionable INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES deal_services(id) ON DELETE SET NULL,
      FOREIGN KEY (bdr_id) REFERENCES bdr_reps(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS commission_entries (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      bdr_id TEXT NOT NULL,
      month TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('accrued', 'pending', 'payable', 'paid', 'cancelled')),
      revenue_event_id TEXT,
      accrual_date TEXT,
      payable_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (deal_id) REFERENCES deals(id),
      FOREIGN KEY (bdr_id) REFERENCES bdr_reps(id),
      FOREIGN KEY (revenue_event_id) REFERENCES revenue_events(id)
    );

    CREATE TABLE IF NOT EXISTS quarterly_targets (
      id TEXT PRIMARY KEY,
      bdr_id TEXT NOT NULL,
      quarter TEXT NOT NULL,
      target_revenue REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(bdr_id, quarter),
      FOREIGN KEY (bdr_id) REFERENCES bdr_reps(id)
    );

    CREATE TABLE IF NOT EXISTS quarterly_performance (
      id TEXT PRIMARY KEY,
      bdr_id TEXT NOT NULL,
      quarter TEXT NOT NULL,
      revenue_collected REAL NOT NULL DEFAULT 0,
      achieved_percent REAL NOT NULL DEFAULT 0,
      bonus_eligible INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(bdr_id, quarter),
      FOREIGN KEY (bdr_id) REFERENCES bdr_reps(id)
    );

    CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
    CREATE INDEX IF NOT EXISTS idx_deals_bdr_id ON deals(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_deals_client_id ON deals(client_id);
    CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
    CREATE INDEX IF NOT EXISTS idx_deals_cancellation_date ON deals(cancellation_date);
    CREATE INDEX IF NOT EXISTS idx_deals_first_invoice_date ON deals(first_invoice_date);
    CREATE INDEX IF NOT EXISTS idx_deal_services_deal_id ON deal_services(deal_id);
    CREATE INDEX IF NOT EXISTS idx_deal_services_billing_type ON deal_services(billing_type);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_bdr_id ON commission_entries(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_deal_id ON commission_entries(deal_id);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_month ON commission_entries(month);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_status ON commission_entries(status);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_revenue_event_id ON commission_entries(revenue_event_id);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_accrual_date ON commission_entries(accrual_date);
    CREATE INDEX IF NOT EXISTS idx_commission_entries_payable_date ON commission_entries(payable_date);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_deal_id ON revenue_events(deal_id);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_service_id ON revenue_events(service_id);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_bdr_id ON revenue_events(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_collection_date ON revenue_events(collection_date);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_billing_type ON revenue_events(billing_type);
    CREATE INDEX IF NOT EXISTS idx_revenue_events_payment_stage ON revenue_events(payment_stage);
    CREATE INDEX IF NOT EXISTS idx_quarterly_targets_bdr_id ON quarterly_targets(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_quarterly_performance_bdr_id ON quarterly_performance(bdr_id);
    CREATE INDEX IF NOT EXISTS idx_bdr_reps_email ON bdr_reps(email);

    -- Insert default commission rules
    INSERT INTO commission_rules (id, base_rate, quarterly_bonus_rate, renewal_rate, payout_months_default, payout_delay_days, tier_1_threshold, tier_1_rate, tier_2_rate, quarterly_target, clawback_days)
    VALUES (lower(hex(randomblob(16))), 0.025, 0.025, 0.01, 12, 30, 250000.00, 0.025, 0.05, 75000.00, 90);

    -- Create default test users if they don't exist
    INSERT OR IGNORE INTO bdr_reps (id, name, email, status, allow_trailing_commission, created_at, updated_at)
    VALUES 
      ('admin-user-id', 'Admin User', 'admin@example.com', 'active', 0, datetime('now'), datetime('now')),
      ('test-bdr-id', 'Test BDR', 'test@example.com', 'active', 0, datetime('now'), datetime('now'));
  `);

  if (process.env.NODE_ENV === 'development') {
    console.log('Local SQLite database initialized');
    console.log('Default users created:');
    console.log('  - Admin: admin@example.com (password: any)');
    console.log('  - BDR: test@example.com (password: any)');
  }
}

export function closeLocalDB() {
  if (db) {
    db.close();
    db = null;
  }
}



