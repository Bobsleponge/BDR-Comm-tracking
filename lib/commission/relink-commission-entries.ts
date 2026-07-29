/**
 * Wire commission_entries to revenue_events after reprocess or data repair.
 */

import { amountsMatch } from '@/lib/commission/approval-lock';

const AMOUNT_TOLERANCE = 0.03;

export interface RelinkResult {
  linked: number;
  unlinkedEntries: number;
  orphanRevenueEvents: number;
}

type Db = {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => unknown;
  };
};

function entryNeedsRelink(
  db: Db,
  entry: { id: string; revenue_event_id: string | null }
): boolean {
  if (!entry.revenue_event_id) return true;
  const exists = db.prepare('SELECT 1 FROM revenue_events WHERE id = ?').get(entry.revenue_event_id);
  return !exists;
}

function eventIsUnlinked(db: Db, eventId: string): boolean {
  const ce = db.prepare(
    `SELECT 1 FROM commission_entries WHERE revenue_event_id = ? AND status != 'cancelled'`
  ).get(eventId);
  return !ce;
}

export function relinkCommissionEntriesForDeal(db: Db, dealId: string, rate = 0.025): RelinkResult {
  const entries = db
    .prepare(
      `SELECT id, service_id, amount, payable_date, accrual_date, revenue_event_id
       FROM commission_entries WHERE deal_id = ? AND status != 'cancelled'`
    )
    .all(dealId) as Array<{
    id: string;
    service_id: string | null;
    amount: number;
    payable_date: string | null;
    accrual_date: string | null;
    revenue_event_id: string | null;
  }>;

  const events = db
    .prepare(
      `SELECT id, service_id, amount_collected, collection_date
       FROM revenue_events WHERE deal_id = ? AND commissionable = 1`
    )
    .all(dealId) as Array<{
    id: string;
    service_id: string | null;
    amount_collected: number;
    collection_date: string;
  }>;

  const update = db.prepare(
    `UPDATE commission_entries SET revenue_event_id = ?, updated_at = datetime('now') WHERE id = ?`
  );

  const usedEvents = new Set<string>();
  let linked = 0;

  const needsLink = entries.filter((e) => entryNeedsRelink(db, e));

  for (const entry of needsLink) {
    const entryPayable = String(entry.payable_date || entry.accrual_date || '').slice(0, 10);
    let best: { id: string; score: number } | null = null;

    for (const event of events) {
      if (usedEvents.has(event.id)) continue;
      if (entry.service_id && event.service_id && entry.service_id !== event.service_id) continue;

      const expectedAmount = Number(event.amount_collected) * rate;
      if (!amountsMatch(Number(entry.amount), expectedAmount, AMOUNT_TOLERANCE)) continue;

      const coll = String(event.collection_date).slice(0, 10);
      const dateScore = entryPayable && coll
        ? Math.abs(
            new Date(entryPayable).getTime() - new Date(coll).getTime()
          ) / (1000 * 60 * 60 * 24)
        : 999;

      if (!best || dateScore < best.score) {
        best = { id: event.id, score: dateScore };
      }
    }

    if (best && best.score <= 45) {
      update.run(best.id, entry.id);
      usedEvents.add(best.id);
      linked++;
    }
  }

  const unlinkedEntries = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM commission_entries ce
         WHERE ce.deal_id = ? AND ce.status != 'cancelled'
           AND (ce.revenue_event_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM revenue_events re WHERE re.id = ce.revenue_event_id
           ))`
      )
      .get(dealId) as { c: number }
  ).c;

  const orphanRevenueEvents = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM revenue_events re
         WHERE re.deal_id = ? AND re.commissionable = 1
           AND NOT EXISTS (
             SELECT 1 FROM commission_entries ce
             WHERE ce.revenue_event_id = re.id AND ce.status != 'cancelled'
           )`
      )
      .get(dealId) as { c: number }
  ).c;

  return { linked, unlinkedEntries, orphanRevenueEvents };
}

/** Remove extra CE rows pointing at the same revenue_event_id (keep batch-linked / paid). */
export function removeDuplicateEntriesPerRevenueEvent(db: Db, dealId: string): number {
  const groups = db
    .prepare(
      `SELECT ce.id, ce.revenue_event_id, ce.status, ce.invoiced_batch_id,
              (SELECT COUNT(*) FROM commission_batch_items cbi WHERE cbi.commission_entry_id = ce.id) as batch_items
       FROM commission_entries ce
       WHERE ce.deal_id = ? AND ce.status != 'cancelled' AND ce.revenue_event_id IS NOT NULL`
    )
    .all(dealId) as Array<{
    id: string;
    revenue_event_id: string;
    status: string;
    invoiced_batch_id: string | null;
    batch_items: number;
  }>;

  const byRe = new Map<string, typeof groups>();
  for (const row of groups) {
    const list = byRe.get(row.revenue_event_id) ?? [];
    list.push(row);
    byRe.set(row.revenue_event_id, list);
  }

  const score = (r: (typeof groups)[0]) => {
    if (r.status === 'paid') return 100;
    if (r.status === 'ignored') return 90;
    if (r.batch_items > 0 || r.invoiced_batch_id) return 80;
    return 10;
  };

  const del = db.prepare('DELETE FROM commission_entries WHERE id = ?');
  let removed = 0;
  for (const [, rows] of byRe) {
    if (rows.length <= 1) continue;
    const sorted = [...rows].sort((a, b) => score(b) - score(a));
    for (const row of sorted.slice(1)) {
      del.run(row.id);
      removed++;
    }
  }
  return removed;
}

export function removeDuplicateCommissionEntries(db: Db, dealId: string): number {
  const groups = db
    .prepare(
      `SELECT ce.id, ce.service_id, ce.payable_date, ce.status, ce.revenue_event_id, ce.invoiced_batch_id,
              (SELECT COUNT(*) FROM commission_batch_items cbi WHERE cbi.commission_entry_id = ce.id) as batch_items
       FROM commission_entries ce
       WHERE ce.deal_id = ? AND ce.status != 'cancelled'
       ORDER BY ce.payable_date, ce.created_at`
    )
    .all(dealId) as Array<{
    id: string;
    service_id: string | null;
    payable_date: string | null;
    status: string;
    revenue_event_id: string | null;
    invoiced_batch_id: string | null;
    batch_items: number;
  }>;

  const byKey = new Map<string, typeof groups>();
  for (const row of groups) {
    const month = String(row.payable_date || '').slice(0, 7);
    const key = `${row.service_id || 'none'}|${month}`;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }

  const score = (r: (typeof groups)[0]) => {
    if (r.status === 'paid') return 100;
    if (r.status === 'ignored') return 90;
    if (r.batch_items > 0 || r.invoiced_batch_id) return 80;
    if (r.revenue_event_id) return 60;
    return 10;
  };

  const del = db.prepare('DELETE FROM commission_entries WHERE id = ?');
  let removed = 0;

  for (const [, rows] of byKey) {
    if (rows.length <= 1) continue;
    const sorted = [...rows].sort((a, b) => score(b) - score(a));
    for (const row of sorted.slice(1)) {
      if (row.batch_items > 0 || row.status === 'paid') continue;
      del.run(row.id);
      removed++;
    }
  }

  return removed;
}
