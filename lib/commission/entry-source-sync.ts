import type Database from 'better-sqlite3';
import { computeNetSalesCommissionAmount } from '@/lib/commission/net-sales-commission';

type Db = Database.Database;

/**
 * When amount claimed changes on a report line, persist to revenue_events and
 * recalculate commission_entries so quarterly/annual dashboards stay in sync.
 */
export function syncAmountClaimedToSourceTables(
  db: Db,
  batchId: string,
  commissionEntryId: string,
  amountCollected: number | null
): void {
  if (amountCollected == null) return;

  const row = db
    .prepare(`
    SELECT
      ce.revenue_event_id,
      cbi.override_amount,
      cbi.override_commission_rate,
      ds.billing_type,
      ds.billing_percentage,
      ds.original_billing_percentage,
      ds.is_renewal,
      ds.commission_rate
    FROM commission_entries ce
    JOIN commission_batch_items cbi ON cbi.commission_entry_id = ce.id AND cbi.batch_id = ?
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
    WHERE ce.id = ?
  `)
    .get(batchId, commissionEntryId) as {
    revenue_event_id: string | null;
    service_id: string | null;
    override_amount: number | null;
    override_commission_rate: number | null;
    billing_type: string | null;
    billing_percentage: number | null;
    original_billing_percentage: number | null;
    is_renewal: number | boolean | null;
    commission_rate: number | null;
  } | undefined;

  if (!row) return;

  if (row.revenue_event_id) {
    db.prepare(`
      UPDATE revenue_events
      SET amount_collected = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(amountCollected, row.revenue_event_id);
  }

  if (row.override_amount != null) return;

  if (
    !row.revenue_event_id &&
    row.billing_type === 'percentage_of_net_sales' &&
    row.billing_percentage != null &&
    row.billing_percentage > 0
  ) {
    const rules = db.prepare('SELECT base_rate FROM commission_rules LIMIT 1').get() as { base_rate?: number } | undefined;
    const baseRate = rules?.base_rate ?? 0.025;
    const amountToSave = computeNetSalesCommissionAmount(
      amountCollected,
      row.billing_percentage,
      baseRate,
      {
        isRenewal: !!(row.is_renewal === 1 || row.is_renewal === true),
        originalBillingPercentage: row.original_billing_percentage,
      }
    );
    if (amountToSave != null) {
      db.prepare('UPDATE commission_entries SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        amountToSave,
        commissionEntryId
      );
    }
    return;
  }

  const rate = row.override_commission_rate ?? row.commission_rate ?? 0.025;
  const commissionAmount = Number((amountCollected * rate).toFixed(2));
  db.prepare('UPDATE commission_entries SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    commissionAmount,
    commissionEntryId
  );
}

/** Ignored entries should not count toward quarterly bonus or annual tier revenue. */
export function syncIgnoredEntrySideEffects(db: Db, commissionEntryId: string): void {
  const row = db
    .prepare('SELECT revenue_event_id FROM commission_entries WHERE id = ?')
    .get(commissionEntryId) as { revenue_event_id: string | null } | undefined;
  if (row?.revenue_event_id) {
    db.prepare(`
      UPDATE revenue_events
      SET commissionable = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(row.revenue_event_id);
  }
}

/** SQL fragment: exclude revenue tied to ignored commission entries. */
export const EXCLUDE_IGNORED_REVENUE_SQL = `
  AND NOT EXISTS (
    SELECT 1 FROM commission_entries ce_ign
    WHERE ce_ign.revenue_event_id = re.id AND ce_ign.status = 'ignored'
  )
`;
