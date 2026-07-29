import 'server-only';

import { isEntryApprovalSettled } from '@/lib/commission/approval-lock';
import { isEntryIgnored } from '@/lib/commission/entry-status';
import { getDealApprovalLocks, invalidateApprovalLockCache } from '@/lib/commission/approval-lock-store';
import { syncApprovalSettlementForDeal } from '@/lib/commission/sync-approval-settlement';
import { createRevenueEventsForDeal, processRevenueEvent } from '@/lib/commission/revenue-events';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export interface SafeReprocessResult {
  eventsProcessed: number;
  skippedMonths: string[];
  preservedEntryCount: number;
  deletedEntryCount: number;
  settlementSync?: { markedPaid: number; markedApproved: number };
  relinked?: number;
  duplicatesRemoved?: number;
  unlinkedEntries?: number;
  orphanRevenueEvents?: number;
}

/**
 * Rebuild revenue events and commission entries for a deal while preserving
 * approved/fingerprinted months (no duplicate billing on locked periods).
 */
export async function safeReprocessDeal(dealId: string): Promise<SafeReprocessResult> {
  invalidateApprovalLockCache();
  const dealLocks = await getDealApprovalLocks(dealId);
  const skipMonths = new Set(dealLocks.locks.map((l) => l.month));

  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const deal = db.prepare('SELECT id FROM deals WHERE id = ?').get(dealId) as { id: string } | undefined;
    if (!deal) {
      throw new Error('Deal not found');
    }

    const allEntries = db.prepare(`
      SELECT id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status
      FROM commission_entries
      WHERE deal_id = ?
    `).all(dealId) as Array<{
      id: string;
      bdr_id: string;
      deal_id: string;
      amount: number;
      payable_date: string | null;
      accrual_date: string | null;
      month: string | null;
      status: string | null;
    }>;

    let deletedEntryCount = 0;
    let preservedEntryCount = 0;

    for (const entry of allEntries) {
      if (isEntryApprovalSettled(entry, dealLocks, allEntries) || isEntryIgnored(entry.status)) {
        preservedEntryCount++;
        continue;
      }
      db.prepare('DELETE FROM commission_entries WHERE id = ?').run(entry.id);
      deletedEntryCount++;
    }

    db.prepare('DELETE FROM revenue_events WHERE deal_id = ?').run(dealId);

    const services = db.prepare('SELECT id FROM deal_services WHERE deal_id = ?').all(dealId) as Array<{ id: string }>;
    if (services.length === 0) {
      const settlementSync = await syncApprovalSettlementForDeal(dealId);
      return {
        eventsProcessed: 0,
        skippedMonths: [...skipMonths],
        preservedEntryCount,
        deletedEntryCount,
        settlementSync,
      };
    }

    await createRevenueEventsForDeal(dealId);

    const revenueEvents = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ?').all(dealId) as Array<{ id: string }>;
    for (const event of revenueEvents) {
      try {
        const existingEntries = db.prepare(`
          SELECT id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status
          FROM commission_entries WHERE deal_id = ?
        `).all(dealId) as typeof allEntries;
        await processRevenueEvent(event.id, { dealLocks, existingEntries });
      } catch (error) {
        console.error(`[safeReprocess] Error processing revenue event ${event.id}:`, error);
      }
    }

    // Second pass: fill commission entries for revenue events still missing a CE
    const orphanEvents = db
      .prepare(
        `SELECT id FROM revenue_events re
         WHERE re.deal_id = ? AND re.commissionable = 1
           AND NOT EXISTS (
             SELECT 1 FROM commission_entries ce
             WHERE ce.revenue_event_id = re.id AND ce.status != 'cancelled'
           )`
      )
      .all(dealId) as Array<{ id: string }>;

    for (const event of orphanEvents) {
      try {
        const existingEntries = db.prepare(`
          SELECT id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status
          FROM commission_entries WHERE deal_id = ?
        `).all(dealId) as typeof allEntries;
        await processRevenueEvent(event.id, {
          dealLocks,
          existingEntries,
          bypassApprovalLock: true,
        });
      } catch (error) {
        console.error(`[safeReprocess] Orphan fill error ${event.id}:`, error);
      }
    }

    const { relinkCommissionEntriesForDeal, removeDuplicateCommissionEntries, removeDuplicateEntriesPerRevenueEvent } =
      await import('@/lib/commission/relink-commission-entries');
    const relink = relinkCommissionEntriesForDeal(db, dealId);
    const dupesRemoved =
      removeDuplicateCommissionEntries(db, dealId) + removeDuplicateEntriesPerRevenueEvent(db, dealId);

    const settlementSync = await syncApprovalSettlementForDeal(dealId);

    return {
      eventsProcessed: revenueEvents.length,
      skippedMonths: [...skipMonths],
      preservedEntryCount,
      deletedEntryCount,
      settlementSync,
      relinked: relink.linked,
      duplicatesRemoved: dupesRemoved,
      unlinkedEntries: relink.unlinkedEntries,
      orphanRevenueEvents: relink.orphanRevenueEvents,
    };
  }

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient() as any;

  const dealResult = await supabase.from('deals').select('id').eq('id', dealId).single();
  if (dealResult.error || !dealResult.data) {
    throw new Error('Deal not found');
  }

  const { data: allEntries } = await supabase
    .from('commission_entries')
    .select('id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status')
    .eq('deal_id', dealId);

  let deletedEntryCount = 0;
  let preservedEntryCount = 0;
  const toDelete: string[] = [];

  for (const entry of allEntries || []) {
    if (isEntryApprovalSettled(entry, dealLocks, allEntries || []) || isEntryIgnored(entry.status)) {
      preservedEntryCount++;
    } else {
      toDelete.push(entry.id);
    }
  }

  if (toDelete.length > 0) {
    await supabase.from('commission_entries').delete().in('id', toDelete);
    deletedEntryCount = toDelete.length;
  }

  await supabase.from('revenue_events').delete().eq('deal_id', dealId);

  const { data: services } = await supabase.from('deal_services').select('id').eq('deal_id', dealId);
  if (!services || services.length === 0) {
    const settlementSync = await syncApprovalSettlementForDeal(dealId);
    return {
      eventsProcessed: 0,
      skippedMonths: [...skipMonths],
      preservedEntryCount,
      deletedEntryCount,
      settlementSync,
    };
  }

  await createRevenueEventsForDeal(dealId);

  const eventsResult = await supabase.from('revenue_events').select('id').eq('deal_id', dealId);
  const revenueEvents = eventsResult.data || [];

  for (const event of revenueEvents) {
    try {
      const { data: existingEntries } = await supabase
        .from('commission_entries')
        .select('id, bdr_id, deal_id, amount, payable_date, accrual_date, month, status')
        .eq('deal_id', dealId);
      await processRevenueEvent(event.id, {
        dealLocks,
        existingEntries: existingEntries || [],
      });
    } catch (error) {
      console.error(`[safeReprocess] Error processing revenue event ${event.id}:`, error);
    }
  }

  const settlementSync = await syncApprovalSettlementForDeal(dealId);

  return {
    eventsProcessed: revenueEvents.length,
    skippedMonths: [...skipMonths],
    preservedEntryCount,
    deletedEntryCount,
    settlementSync,
  };
}
