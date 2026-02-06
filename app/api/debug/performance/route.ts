import { NextRequest, NextResponse } from 'next/server';
import { getSlowQueries, clearLogs } from '@/lib/db/performance-monitor';
import { requireAuth, requireAdmin } from '@/lib/utils/api-helpers';

/**
 * Debug endpoint to view slow queries
 * Only accessible to admins
 */
export async function GET(request: NextRequest) {
  try {
    // In local mode, allow access without admin check for debugging
    const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!USE_LOCAL_DB) {
      await requireAuth();
      await requireAdmin();
    }
    
    const slowQueries = getSlowQueries();
    
    return NextResponse.json({
      slowQueries,
      count: slowQueries.length,
      message: 'Access /api/debug/performance?clear=true to clear logs',
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // In local mode, allow access without admin check for debugging
    const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!USE_LOCAL_DB) {
      await requireAuth();
      await requireAdmin();
    }
    
    clearLogs();
    
    return NextResponse.json({ message: 'Performance logs cleared' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
}

