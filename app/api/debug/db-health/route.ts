import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin } from '@/lib/utils/api-helpers';
import { getLocalDB } from '@/lib/db/local-db';
import { statSync } from 'fs';
import { join } from 'path';

/**
 * Database health check endpoint
 * Shows database file size, query performance, and potential issues
 */
const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    // In local mode, allow access without admin check for debugging
    if (!USE_LOCAL_DB) {
      await requireAuth();
      await requireAdmin();
    }
    
    if (!USE_LOCAL_DB) {
      return NextResponse.json({ 
        mode: 'supabase',
        message: 'Health check only available for local database mode'
      });
    }
    
    const db = getLocalDB();
    const dbPath = join(process.cwd(), 'local.db');
    
    // Get database file size
    let dbSize = 0;
    let walSize = 0;
    try {
      const stats = statSync(dbPath);
      dbSize = stats.size;
      
      try {
        const walStats = statSync(dbPath + '-wal');
        walSize = walStats.size;
      } catch {
        // WAL file doesn't exist
      }
    } catch (error) {
      // File doesn't exist or can't be read
    }
    
    // Get table counts
    const tableCounts: Record<string, number> = {};
    const tables = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all() as { name: string }[];
    
    for (const table of tables) {
      try {
        const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get() as { count: number };
        tableCounts[table.name] = count.count;
      } catch (error) {
        tableCounts[table.name] = -1; // Error counting
      }
    }
    
    // Check for missing indexes on key columns
    const missingIndexes: string[] = [];
    const indexCheck = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='index' AND name NOT LIKE 'sqlite_%'
    `).all() as { name: string }[];
    const indexNames = new Set(indexCheck.map(i => i.name));
    
    // Check critical indexes
    if (!indexNames.has('idx_deals_bdr_id')) missingIndexes.push('deals.bdr_id');
    if (!indexNames.has('idx_commission_entries_bdr_id')) missingIndexes.push('commission_entries.bdr_id');
    if (!indexNames.has('idx_revenue_events_bdr_id')) missingIndexes.push('revenue_events.bdr_id');
    
    // Test query performance
    const testStart = Date.now();
    try {
      db.prepare('SELECT COUNT(*) FROM deals LIMIT 1').get();
    } catch (error) {
      // Ignore
    }
    const testQueryTime = Date.now() - testStart;
    
    // Get database settings
    const journalMode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const synchronous = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    const cacheSize = db.prepare('PRAGMA cache_size').get() as { cache_size: number };
    
    return NextResponse.json({
      health: 'ok',
      database: {
        path: dbPath,
        size: {
          main: dbSize,
          wal: walSize,
          total: dbSize + walSize,
          formatted: {
            main: formatBytes(dbSize),
            wal: formatBytes(walSize),
            total: formatBytes(dbSize + walSize),
          }
        },
        settings: {
          journal_mode: journalMode.journal_mode,
          synchronous: synchronous.synchronous,
          cache_size: cacheSize.cache_size,
        },
        tables: tableCounts,
        totalRows: Object.values(tableCounts).reduce((sum, count) => sum + (count > 0 ? count : 0), 0),
        indexes: {
          count: indexNames.size,
          missing: missingIndexes,
        },
        performance: {
          testQueryTime: `${testQueryTime}ms`,
          status: testQueryTime > 1000 ? 'slow' : testQueryTime > 100 ? 'moderate' : 'fast',
        },
        recommendations: generateRecommendations(dbSize, walSize, tableCounts, testQueryTime, missingIndexes),
      }
    });
  } catch (error: any) {
    return NextResponse.json({ 
      health: 'error',
      error: error.message 
    }, { status: 500 });
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function generateRecommendations(
  dbSize: number,
  walSize: number,
  tableCounts: Record<string, number>,
  testQueryTime: number,
  missingIndexes: string[]
): string[] {
  const recommendations: string[] = [];
  
  if (dbSize > 100 * 1024 * 1024) { // > 100MB
    recommendations.push('Database file is large. Consider archiving old data.');
  }
  
  if (walSize > 50 * 1024 * 1024) { // > 50MB
    recommendations.push('WAL file is large. Consider running VACUUM to checkpoint WAL.');
  }
  
  if (testQueryTime > 1000) {
    recommendations.push('Query performance is slow. Check for missing indexes or database locks.');
  }
  
  if (missingIndexes.length > 0) {
    recommendations.push(`Missing critical indexes on: ${missingIndexes.join(', ')}`);
  }
  
  const totalRows = Object.values(tableCounts).reduce((sum, count) => sum + (count > 0 ? count : 0), 0);
  if (totalRows > 100000) {
    recommendations.push('Large number of rows. Consider pagination and query optimization.');
  }
  
  if (recommendations.length === 0) {
    recommendations.push('Database appears healthy. No immediate issues detected.');
  }
  
  return recommendations;
}

