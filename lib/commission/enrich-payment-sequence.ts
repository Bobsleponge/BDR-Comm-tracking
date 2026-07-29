import type { Database } from 'better-sqlite3';
import {
  buildPaymentSequenceIndexForService,
  singlePaymentSequence,
  type PaymentSequence,
  type RevenueEventForSequence,
  type ServiceForPaymentCount,
} from '@/lib/commission/payment-sequence';

type ServiceRow = ServiceForPaymentCount & { id: string };

/**
 * Batch-load payment sequence for commission lines (local SQLite).
 * Keys results by revenue_event_id when present, else commission_entry id.
 */
export function buildPaymentSequenceMapLocal(
  db: Database,
  lines: Array<{
    commission_entry_id: string;
    revenue_event_id?: string | null;
    service_id?: string | null;
  }>
): Map<string, PaymentSequence> {
  if (lines.length === 0) return new Map();

  const serviceIds = new Set<string>();
  for (const line of lines) {
    if (line.service_id) serviceIds.add(line.service_id);
  }

  // Resolve service_id from revenue events when missing on the line
  const reIds = lines.map((l) => l.revenue_event_id).filter(Boolean) as string[];
  const reToService = new Map<string, string>();
  if (reIds.length > 0) {
    const placeholders = reIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, service_id FROM revenue_events WHERE id IN (${placeholders})`)
      .all(...reIds) as Array<{ id: string; service_id: string | null }>;
    for (const r of rows) {
      if (r.service_id) {
        reToService.set(r.id, r.service_id);
        serviceIds.add(r.service_id);
      }
    }
  }

  const serviceById = new Map<string, ServiceRow>();
  if (serviceIds.size > 0) {
    const placeholders = [...serviceIds].map(() => '?').join(',');
    const services = db
      .prepare(
        `SELECT id, billing_type, contract_months, contract_quarters, completion_date, is_renewal
         FROM deal_services WHERE id IN (${placeholders})`
      )
      .all(...[...serviceIds]) as ServiceRow[];
    for (const s of services) serviceById.set(s.id, s);
  }

  const eventsByService = new Map<string, RevenueEventForSequence[]>();
  if (serviceIds.size > 0) {
    const placeholders = [...serviceIds].map(() => '?').join(',');
    const events = db
      .prepare(
        `SELECT id, service_id, collection_date, payment_stage
         FROM revenue_events
         WHERE service_id IN (${placeholders}) AND commissionable = 1
         ORDER BY collection_date, id`
      )
      .all(...[...serviceIds]) as Array<RevenueEventForSequence & { service_id: string }>;
    for (const ev of events) {
      if (!ev.service_id) continue;
      const list = eventsByService.get(ev.service_id) ?? [];
      list.push({ id: ev.id, collection_date: ev.collection_date, payment_stage: ev.payment_stage });
      eventsByService.set(ev.service_id, list);
    }
  }

  const indexByService = new Map<string, Map<string, PaymentSequence>>();
  for (const [sid, events] of eventsByService) {
    indexByService.set(sid, buildPaymentSequenceIndexForService(serviceById.get(sid), events));
  }

  return assignPaymentSequencesToLines(lines, serviceById, indexByService, reToService);
}

export function assignPaymentSequencesToLines(
  lines: Array<{
    commission_entry_id: string;
    revenue_event_id?: string | null;
    service_id?: string | null;
  }>,
  _serviceById: Map<string, ServiceRow>,
  indexByService: Map<string, Map<string, PaymentSequence>>,
  reToService: Map<string, string> = new Map()
): Map<string, PaymentSequence> {
  const out = new Map<string, PaymentSequence>();

  for (const line of lines) {
    const reId = line.revenue_event_id ?? null;
    const sid = line.service_id ?? (reId ? reToService.get(reId) : undefined);

    let seq: PaymentSequence | null = null;
    if (reId && sid) {
      seq = indexByService.get(sid)?.get(reId) ?? null;
    }
    if (!seq) seq = singlePaymentSequence();

    if (reId) out.set(reId, seq);
    out.set(line.commission_entry_id, seq);
  }

  return out;
}

export function buildPaymentSequenceMapFromPreloaded(
  lines: Array<{
    commission_entry_id: string;
    revenue_event_id?: string | null;
    service_id?: string | null;
  }>,
  services: ServiceRow[],
  events: Array<RevenueEventForSequence & { service_id: string | null }>
): Map<string, PaymentSequence> {
  const serviceById = new Map<string, ServiceRow>();
  for (const s of services) serviceById.set(s.id, s);

  const eventsByService = new Map<string, RevenueEventForSequence[]>();
  for (const ev of events) {
    if (!ev.service_id) continue;
    const list = eventsByService.get(ev.service_id) ?? [];
    list.push({ id: ev.id, collection_date: ev.collection_date, payment_stage: ev.payment_stage });
    eventsByService.set(ev.service_id, list);
  }

  const indexByService = new Map<string, Map<string, PaymentSequence>>();
  for (const [sid, evs] of eventsByService) {
    indexByService.set(sid, buildPaymentSequenceIndexForService(serviceById.get(sid), evs));
  }

  const reToService = new Map<string, string>();
  for (const ev of events) {
    if (ev.service_id) reToService.set(ev.id, ev.service_id);
  }

  return assignPaymentSequencesToLines(lines, serviceById, indexByService, reToService);
}

export function lookupPaymentSequence(
  map: Map<string, PaymentSequence>,
  revenueEventId: string | null | undefined,
  commissionEntryId: string
): PaymentSequence {
  if (revenueEventId && map.has(revenueEventId)) return map.get(revenueEventId)!;
  if (map.has(commissionEntryId)) return map.get(commissionEntryId)!;
  return singlePaymentSequence();
}
