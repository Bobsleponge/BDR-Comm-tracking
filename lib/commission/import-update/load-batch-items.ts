import type Database from 'better-sqlite3';
import {
  attachPaymentSequencesToBatchItems,
  buildExportRows,
  effectiveAmountCollected,
} from '@/lib/commission/export-rows';
import type { BatchItemForImport } from './types';

type Db = Database.Database;

/**
 * Load batch items in the shape used for import matching/diffing.
 */
export function loadBatchItemsForImport(db: Db, batchId: string): BatchItemForImport[] {
  const items = db.prepare(`
    SELECT
      cbi.id as batch_item_id,
      cbi.commission_entry_id,
      cbi.override_amount,
      cbi.override_payment_date,
      cbi.override_commission_rate,
      cbi.override_amount_collected,
      cbi.adjustment_note,
      ce.amount as original_amount,
      ce.payable_date,
      ce.accrual_date,
      d.client_name,
      d.service_type as deal_service_type,
      d.deal_value,
      d.original_deal_value,
      d.is_renewal as deal_is_renewal,
      ds.service_name,
      ds.commission_rate,
      ds.billing_type,
      ds.is_renewal as service_is_renewal,
      ds.original_service_value,
      ds.commissionable_value,
      re.id as revenue_event_id,
      re.billing_type as re_billing_type,
      re.collection_date,
      re.amount_collected,
      ds.id as service_id
    FROM commission_batch_items cbi
    JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
    JOIN deals d ON ce.deal_id = d.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
    WHERE cbi.batch_id = ?
  `).all(batchId) as Array<Record<string, unknown>>;

  const withSeq = attachPaymentSequencesToBatchItems(db, items);
  const exportRows = buildExportRows(withSeq);

  return withSeq.map((raw, idx) => {
    const exp = exportRows[idx];
    const sourceItem = items[idx] as Record<string, unknown>;
    const effectiveCollected = effectiveAmountCollected(
      raw.override_amount_collected as number | null,
      raw.amount_collected as number | null
    );
    return {
      commission_entry_id: String(raw.commission_entry_id),
      batch_item_id: String(sourceItem?.batch_item_id ?? idx),
      client_name: String(raw.client_name ?? ''),
      service_name: String(raw.service_name ?? ''),
      deal_label: exp.deal,
      payment_sequence: exp.payment_sequence,
      payable_date: exp.payable_date,
      amount_claimed_on: exp.amount_claimed_on,
      is_renewal: exp.is_renewal,
      previous_deal_amount: exp.previous_deal_amount,
      new_deal_amount: exp.new_deal_amount,
      commission_pct: exp.commission_pct,
      original_commission: exp.original_commission,
      override_amount: exp.override_amount,
      final_invoiced_amount: exp.final_invoiced_amount,
      adjustment_note: (sourceItem.adjustment_note as string | null) ?? null,
      override_payment_date: (raw.override_payment_date as string | null) ?? null,
      override_commission_rate: (raw.override_commission_rate as number | null) ?? null,
      override_amount_collected: (raw.override_amount_collected as number | null) ?? null,
      amount: (raw.original_amount as number | null) ?? null,
      amount_collected: effectiveCollected,
      commission_rate: (raw.commission_rate as number | null) ?? null,
      billing_type: String(sourceItem.billing_type ?? ''),
    };
  });
}

/**
 * Load batch items from approved/paid snapshot for comparison (read-only import on approved batches).
 */
export function loadSnapshotItemsForImport(db: Db, batchId: string): BatchItemForImport[] {
  const snapshot = db
    .prepare('SELECT snapshot_data FROM commission_batch_snapshots WHERE batch_id = ?')
    .get(batchId) as { snapshot_data: string } | undefined;
  if (!snapshot?.snapshot_data) return [];

  const rows = JSON.parse(snapshot.snapshot_data) as Array<
    Record<string, unknown> & { commission_entry_id?: string }
  >;

  return rows.map((row, idx) => ({
    commission_entry_id: String(row.commission_entry_id ?? `snapshot-${idx}`),
    batch_item_id: `snapshot-${batchId}-${row.commission_entry_id ?? idx}`,
    client_name: String(row.client_name ?? ''),
    service_name: String(row.deal ?? ''),
    deal_label: String(row.deal ?? ''),
    payment_sequence: String(row.payment_sequence ?? ''),
    payable_date: String(row.payable_date ?? ''),
    amount_claimed_on: String(row.amount_claimed_on ?? ''),
    is_renewal: String(row.is_renewal ?? 'No'),
    previous_deal_amount: String(row.previous_deal_amount ?? ''),
    new_deal_amount: String(row.new_deal_amount ?? ''),
    commission_pct: String(row.commission_pct ?? ''),
    original_commission: String(row.original_commission ?? ''),
    override_amount: String(row.override_amount ?? ''),
    final_invoiced_amount: String(row.final_invoiced_amount ?? ''),
    adjustment_note: (row.adjustment_note as string | null) ?? null,
    override_payment_date: null,
    override_commission_rate: null,
    override_amount_collected: null,
    amount: null,
    amount_collected: null,
    commission_rate: null,
    billing_type: '',
  }));
}
