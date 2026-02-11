import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { parseISO, format } from 'date-fns';
import { createRevenueEventsForDeal, processRevenueEvent } from './revenue-events';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * @deprecated This function is deprecated but kept for backward compatibility with legacy scripts.
 * 
 * **Migration Guide:**
 * Replace calls to this function with:
 * ```typescript
 * import { createRevenueEventsForDeal, processRevenueEvent } from '@/lib/commission/revenue-events';
 * 
 * // Create revenue events for the deal
 * await createRevenueEventsForDeal(dealId);
 * 
 * // Process events that have been collected (collection_date <= today)
 * const today = new Date().toISOString().split('T')[0];
 * const events = await getRevenueEventsForDeal(dealId, today);
 * for (const event of events) {
 *   await processRevenueEvent(event.id);
 * }
 * ```
 * 
 * **Why deprecated:**
 * This function is a wrapper that delegates to the new revenue events system.
 * It's better to use the new functions directly for clarity and better error handling.
 * 
 * Generate and save commission entries for a deal
 * This should be called when a deal is marked as closed-won
 */
export async function scheduleCommissionPayouts(dealId: string): Promise<void> {
  console.warn('scheduleCommissionPayouts is deprecated. Use createRevenueEventsForDeal and processRevenueEvent directly instead.');
  
  // Delegate to new revenue events system
  await createRevenueEventsForDeal(dealId);
  
  // Process revenue events to create commission entries
  // CRITICAL: Only process events where revenue has actually been collected (collection_date <= today)
  // Commission should only accrue when revenue is actually collected, not for future scheduled events
  const today = new Date().toISOString().split('T')[0];
  
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const revenueEvents = db.prepare(`
      SELECT id FROM revenue_events 
      WHERE deal_id = ? AND collection_date <= ?
    `).all(dealId, today) as Array<{ id: string }>;
    
    for (const event of revenueEvents) {
      try {
        await processRevenueEvent(event.id);
      } catch (error) {
        console.error(`Error processing revenue event ${event.id}:`, error);
      }
    }
  } else {
    const supabase = await createClient() as any;
    
    const result = await supabase
      .from('revenue_events')
      .select('id, collection_date')
      .eq('deal_id', dealId);
    
    // Filter for events where collection_date <= today
    const revenueEvents = (result.data || []).filter((event: any) => 
      event.collection_date <= today
    );
    
    for (const event of revenueEvents) {
      try {
        await processRevenueEvent(event.id);
      } catch (error) {
        console.error(`Error processing revenue event ${event.id}:`, error);
      }
    }
  }
}

/**
 * Cancel future revenue events and commission entries for a deal
 */
export async function cancelFutureCommissionEntries(
  dealId: string,
  cancellationDate: Date
): Promise<void> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const cancellationDateStr = format(cancellationDate, 'yyyy-MM-dd');

    // Cancel future revenue events
    db.prepare(`
      UPDATE revenue_events 
      SET commissionable = 0, updated_at = datetime('now')
      WHERE deal_id = ? 
        AND collection_date >= ?
        AND commissionable = 1
    `).run(dealId, cancellationDateStr);

    // Cancel future commission entries
    const monthStart = new Date(
      cancellationDate.getFullYear(),
      cancellationDate.getMonth(),
      1
    );
    const monthStartStr = format(monthStart, 'yyyy-MM-dd');

    db.prepare(`
      UPDATE commission_entries 
      SET status = 'cancelled', updated_at = datetime('now')
      WHERE deal_id = ? 
        AND (status = 'pending' OR status = 'accrued' OR status = 'payable')
        AND accrual_date >= ?
    `).run(dealId, monthStartStr);

    return;
  }

  // Supabase mode
  const supabase = await createClient() as any;
  const cancellationDateStr = format(cancellationDate, 'yyyy-MM-dd');

  // Cancel future revenue events
  await supabase
    .from('revenue_events')
    .update({ commissionable: false })
    .eq('deal_id', dealId)
    .gte('collection_date', cancellationDateStr)
    .eq('commissionable', true);

  // Cancel future commission entries
  const monthStart = new Date(
    cancellationDate.getFullYear(),
    cancellationDate.getMonth(),
    1
  );

  await supabase
    .from('commission_entries')
    .update({ status: 'cancelled' })
    .eq('deal_id', dealId)
    .in('status', ['pending', 'accrued', 'payable'])
    .gte('accrual_date', format(monthStart, 'yyyy-MM-dd'));
}

/**
 * Handle rep leave - cancel future revenue events and commission entries
 */
export async function handleRepLeave(bdrId: string, leaveDate: Date): Promise<void> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    // Get BDR info to check allow_trailing_commission
    const bdr = db.prepare('SELECT * FROM bdr_reps WHERE id = ?').get(bdrId) as any;
    if (!bdr) {
      throw new Error('BDR not found');
    }

    // Update leave_date
    db.prepare(`
      UPDATE bdr_reps 
      SET leave_date = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(format(leaveDate, 'yyyy-MM-dd'), bdrId);

    // If trailing commission not allowed, cancel future events
    if (!bdr.allow_trailing_commission) {
      const leaveDateStr = format(leaveDate, 'yyyy-MM-dd');

      // Cancel future revenue events
      db.prepare(`
        UPDATE revenue_events 
        SET commissionable = 0, updated_at = datetime('now')
        WHERE bdr_id = ? 
          AND collection_date > ?
          AND commissionable = 1
      `).run(bdrId, leaveDateStr);

      // Cancel future commission entries
      const monthStart = new Date(
        leaveDate.getFullYear(),
        leaveDate.getMonth(),
        1
      );
      const monthStartStr = format(monthStart, 'yyyy-MM-dd');

      db.prepare(`
        UPDATE commission_entries 
        SET status = 'cancelled', updated_at = datetime('now')
        WHERE bdr_id = ? 
          AND (status = 'pending' OR status = 'accrued' OR status = 'payable')
          AND accrual_date >= ?
      `).run(bdrId, monthStartStr);
    }

    // Mark all deals as do_not_pay_future
    db.prepare(`
      UPDATE deals 
      SET do_not_pay_future = 1, updated_at = datetime('now')
      WHERE bdr_id = ?
    `).run(bdrId);

    return;
  }

  // Supabase mode
  const supabase = await createClient() as any;

  // Get BDR info
  const bdrResult = await supabase
    .from('bdr_reps')
    .select('*')
    .eq('id', bdrId)
    .single();

  if (bdrResult.error || !bdrResult.data) {
    throw new Error(`BDR not found: ${bdrResult.error?.message}`);
  }

  const bdr = bdrResult.data;

  // Update leave_date
  await supabase
    .from('bdr_reps')
    .update({ leave_date: format(leaveDate, 'yyyy-MM-dd') })
    .eq('id', bdrId);

  // If trailing commission not allowed, cancel future events
  if (!bdr.allow_trailing_commission) {
    const leaveDateStr = format(leaveDate, 'yyyy-MM-dd');

    // Cancel future revenue events
    await supabase
      .from('revenue_events')
      .update({ commissionable: false })
      .eq('bdr_id', bdrId)
      .gt('collection_date', leaveDateStr)
      .eq('commissionable', true);

    // Cancel future commission entries
    const monthStart = new Date(
      leaveDate.getFullYear(),
      leaveDate.getMonth(),
      1
    );

    await supabase
      .from('commission_entries')
      .update({ status: 'cancelled' })
      .eq('bdr_id', bdrId)
      .in('status', ['pending', 'accrued', 'payable'])
      .gte('accrual_date', format(monthStart, 'yyyy-MM-dd'));
  }

  // Mark all deals as do_not_pay_future
  await supabase
    .from('deals')
    .update({ do_not_pay_future: true })
    .eq('bdr_id', bdrId);
}
