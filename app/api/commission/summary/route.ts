import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    // Determine which BDR to query
    let targetBdrId = bdrId;
    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      targetBdrId = userBdrId;
    }

    if (!targetBdrId) {
      return apiError('BDR ID is required', 400);
    }

    if (USE_LOCAL_DB) {
      // Local DB mode - exclude entries from cancelled deals
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Optimize: Use aggregate queries instead of fetching all rows and filtering in JavaScript
      const totals = db.prepare(`
        SELECT 
          SUM(CASE WHEN ce.status = 'paid' THEN ce.amount ELSE 0 END) as earned,
          SUM(CASE WHEN ce.status = 'payable' THEN ce.amount ELSE 0 END) as payable,
          SUM(CASE WHEN ce.status = 'accrued' THEN ce.amount ELSE 0 END) as accrued,
          SUM(CASE WHEN ce.status = 'cancelled' THEN ce.amount ELSE 0 END) as cancelled
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        WHERE ce.bdr_id = ? AND d.cancellation_date IS NULL
      `).get(targetBdrId) as any;

      const earned = Number(totals?.earned || 0);
      const payable = Number(totals?.payable || 0);
      const accrued = Number(totals?.accrued || 0);
      const cancelled = Number(totals?.cancelled || 0);

      // 'pending' includes both 'payable' and 'accrued' for backward compatibility
      const pending = payable + accrued;

      return apiSuccess({
        earned: Number(earned.toFixed(2)),
        pending: Number(pending.toFixed(2)),
        payable: Number(payable.toFixed(2)),
        accrued: Number(accrued.toFixed(2)),
        cancelled: Number(cancelled.toFixed(2)),
        total: Number((earned + pending).toFixed(2)),
      }, 200, { cache: 'no-store' }); // No cache to ensure fresh data
    }

    // Supabase mode - exclude entries from cancelled deals
    const supabase = await createClient();

    // Get commission entries, excluding those from cancelled deals
    const query = (supabase as any)
      .from('commission_entries')
      .select('amount, status, deals!inner(cancellation_date)')
      .eq('bdr_id', targetBdrId)
      .is('deals.cancellation_date', null);
    const queryResult = await query;
    const { data: entries, error: entriesError } = queryResult as { data: any[] | null; error: any };

    if (entriesError) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Commission summary API error:', entriesError);
      }
      return apiError('Failed to fetch commission entries', 500);
    }

    // Calculate totals
    // 'payable' = commission that can be paid now
    // 'accrued' = commission that will be payable in the future
    // 'paid' = commission that has been paid (if status tracking is added)
    const entriesArray = entries || [];
    const earned = entriesArray
      .filter((e: any) => e.status === 'paid')
      .reduce((sum: number, e: any) => sum + Number(e.amount), 0);

    const payable = entriesArray
      .filter((e: any) => e.status === 'payable')
      .reduce((sum: number, e: any) => sum + Number(e.amount), 0);

    const accrued = entriesArray
      .filter((e: any) => e.status === 'accrued')
      .reduce((sum: number, e: any) => sum + Number(e.amount), 0);

    const cancelled = entriesArray
      .filter((e: any) => e.status === 'cancelled')
      .reduce((sum: number, e: any) => sum + Number(e.amount), 0);

    // 'pending' includes both 'payable' and 'accrued' for backward compatibility
    const pending = payable + accrued;

    return apiSuccess({
      earned: Number(earned.toFixed(2)),
      pending: Number(pending.toFixed(2)),
      payable: Number(payable.toFixed(2)),
      accrued: Number(accrued.toFixed(2)),
      cancelled: Number(cancelled.toFixed(2)),
      total: Number((earned + pending).toFixed(2)),
    }, 200, { cache: 'no-store' }); // No cache to ensure fresh data
  } catch (error: any) {
    const errorMessage = error.message || 'Unauthorized';
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission summary API exception:', errorMessage, error);
    }
    return apiError(errorMessage, 401);
  }
}




