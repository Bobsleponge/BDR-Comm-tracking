import type Database from 'better-sqlite3';
import type { ApplyChangePayload } from '@/lib/commission/import-update/types';

type Db = Database.Database;

export interface ApplyChangeResult {
  commission_entry_id: string;
  action: string;
  success: boolean;
  message?: string;
  removed?: boolean;
}

/**
 * Apply a single batch draft action (local SQLite). Used by import apply and batch PATCH.
 */
export async function applyBatchChangeLocal(
  db: Db,
  batchId: string,
  batch: { bdr_id: string; status: string; payable_cutoff?: string | null; run_date?: string },
  change: ApplyChangePayload
): Promise<ApplyChangeResult> {
  const { commission_entry_id, action } = change;

  const itemExists = db
    .prepare('SELECT 1 FROM commission_batch_items WHERE batch_id = ? AND commission_entry_id = ?')
    .get(batchId, commission_entry_id);
  if (!itemExists) {
    return { commission_entry_id, action, success: false, message: 'Entry not found in batch' };
  }

  if (action === 'remove_entry') {
    db.prepare('UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      commission_entry_id
    );
    db.prepare('DELETE FROM commission_batch_items WHERE batch_id = ? AND commission_entry_id = ?').run(
      batchId,
      commission_entry_id
    );
    return { commission_entry_id, action, success: true, removed: true };
  }

  if (action === 'ignore_entry') {
    db.prepare(`
      UPDATE commission_entries
      SET status = 'ignored', invoiced_batch_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(commission_entry_id);
    const { syncIgnoredEntrySideEffects } = await import('@/lib/commission/entry-source-sync');
    syncIgnoredEntrySideEffects(db, commission_entry_id);
    db.prepare('DELETE FROM commission_batch_items WHERE batch_id = ? AND commission_entry_id = ?').run(
      batchId,
      commission_entry_id
    );
    return { commission_entry_id, action, success: true, removed: true };
  }

  if (action === 'adjust_amount') {
    const override_amount = change.override_amount ?? null;
    if (typeof override_amount !== 'number' && override_amount !== null) {
      return { commission_entry_id, action, success: false, message: 'override_amount must be a number or null' };
    }
    db.prepare(`
      UPDATE commission_batch_items
      SET override_amount = ?, updated_at = CURRENT_TIMESTAMP
      WHERE batch_id = ? AND commission_entry_id = ?
    `).run(override_amount, batchId, commission_entry_id);
    if (override_amount != null) {
      db.prepare('UPDATE commission_entries SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        override_amount,
        commission_entry_id
      );
    }
    return { commission_entry_id, action, success: true };
  }

  if (action === 'add_note') {
    db.prepare(`
      UPDATE commission_batch_items
      SET adjustment_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE batch_id = ? AND commission_entry_id = ?
    `).run(change.adjustment_note ?? null, batchId, commission_entry_id);
    return { commission_entry_id, action, success: true };
  }

  if (action === 'update_payment_date') {
    const override_payment_date = change.override_payment_date ?? null;
    db.prepare(`
      UPDATE commission_batch_items
      SET override_payment_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE batch_id = ? AND commission_entry_id = ?
    `).run(override_payment_date, batchId, commission_entry_id);

    if (override_payment_date) {
      db.prepare('UPDATE commission_entries SET payable_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        override_payment_date,
        commission_entry_id
      );
    }

    const { resolveBatchPayableCutoff, effectivePayableDate } = await import('@/lib/commission/batch-payable-cutoff');
    const payableCutoff = resolveBatchPayableCutoff({
      payable_cutoff: batch.payable_cutoff,
      run_date: batch.run_date ?? new Date().toISOString().slice(0, 10),
    });
    let effectiveDate = override_payment_date;
    if (!effectiveDate) {
      const ce = db
        .prepare('SELECT payable_date, accrual_date, month FROM commission_entries WHERE id = ?')
        .get(commission_entry_id) as { payable_date?: string; accrual_date?: string; month?: string } | undefined;
      effectiveDate = effectivePayableDate(null, ce?.payable_date, ce?.accrual_date, ce?.month);
    }
    if (effectiveDate && effectiveDate > payableCutoff) {
      db.prepare('UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        commission_entry_id
      );
      db.prepare('DELETE FROM commission_batch_items WHERE batch_id = ? AND commission_entry_id = ?').run(
        batchId,
        commission_entry_id
      );
      return {
        commission_entry_id,
        action,
        success: true,
        removed: true,
        message: `Moved to future report — payable date after ${payableCutoff}`,
      };
    }
    return { commission_entry_id, action, success: true };
  }

  if (action === 'update_commission_rate') {
    const override_commission_rate = change.override_commission_rate ?? null;
    if (typeof override_commission_rate !== 'number' && override_commission_rate !== null) {
      return { commission_entry_id, action, success: false, message: 'override_commission_rate invalid' };
    }
    db.prepare(`
      UPDATE commission_batch_items
      SET override_commission_rate = ?, updated_at = CURRENT_TIMESTAMP
      WHERE batch_id = ? AND commission_entry_id = ?
    `).run(override_commission_rate, batchId, commission_entry_id);

    const ceRow = db
      .prepare(`
      SELECT ce.service_id, re.service_id as re_service_id
      FROM commission_entries ce
      LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
      WHERE ce.id = ?
    `)
      .get(commission_entry_id) as { service_id: string | null; re_service_id: string | null } | undefined;
    const serviceId = ceRow?.service_id || ceRow?.re_service_id;
    if (serviceId && override_commission_rate != null) {
      db.prepare("UPDATE deal_services SET commission_rate = ?, updated_at = datetime('now') WHERE id = ?").run(
        override_commission_rate,
        serviceId
      );
    }
    return { commission_entry_id, action, success: true };
  }

  if (action === 'update_amount_claimed') {
    const override_amount_collected = change.override_amount_collected ?? null;
    if (typeof override_amount_collected !== 'number' && override_amount_collected !== null) {
      return { commission_entry_id, action, success: false, message: 'override_amount_collected invalid' };
    }
    db.prepare(`
      UPDATE commission_batch_items
      SET override_amount_collected = ?, updated_at = CURRENT_TIMESTAMP
      WHERE batch_id = ? AND commission_entry_id = ?
    `).run(override_amount_collected, batchId, commission_entry_id);

    if (override_amount_collected != null) {
      const { syncAmountClaimedToSourceTables } = await import('@/lib/commission/entry-source-sync');
      syncAmountClaimedToSourceTables(db, batchId, commission_entry_id, override_amount_collected);
    }
    return { commission_entry_id, action, success: true };
  }

  if (action === 'override_to_renewal') {
    const previous_deal_amount = change.previous_deal_amount;
    if (typeof previous_deal_amount !== 'number' || previous_deal_amount < 0) {
      return { commission_entry_id, action, success: false, message: 'previous_deal_amount required' };
    }
    const row = db
      .prepare(`
      SELECT ce.deal_id, ce.revenue_event_id,
             re.amount_collected,
             ds.id as service_id, ds.commissionable_value, ds.commission_rate,
             d.deal_value, d.original_deal_value
      FROM commission_entries ce
      LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
      LEFT JOIN deal_services ds ON re.service_id = ds.id
      INNER JOIN deals d ON ce.deal_id = d.id
      WHERE ce.id = ?
    `)
      .get(commission_entry_id) as Record<string, unknown> | undefined;
    if (!row) {
      return { commission_entry_id, action, success: false, message: 'Entry not found' };
    }
    const prev = Number(previous_deal_amount);
    const newAmount = Number(row.commissionable_value ?? row.amount_collected ?? row.deal_value ?? 0);
    const uplift = Math.max(0, newAmount - prev);
    const rate = Number(row.commission_rate ?? 0.025);
    const commissionAmount = Number((uplift * rate).toFixed(2));

    if (row.service_id) {
      db.prepare(`
        UPDATE deal_services SET is_renewal = 1, original_service_value = ?, commission_amount = ?, updated_at = datetime('now') WHERE id = ?
      `).run(prev, commissionAmount, row.service_id);
    }
    db.prepare(
      `UPDATE deals SET is_renewal = 1, original_deal_value = COALESCE(original_deal_value, ?), updated_at = datetime('now') WHERE id = ?`
    ).run(prev, row.deal_id);
    if (row.revenue_event_id) {
      db.prepare(`UPDATE revenue_events SET amount_collected = ?, billing_type = 'renewal', updated_at = datetime('now') WHERE id = ?`).run(
        uplift,
        row.revenue_event_id
      );
    }
    db.prepare('UPDATE commission_entries SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      commissionAmount,
      commission_entry_id
    );
    db.prepare('UPDATE commission_batch_items SET override_amount = NULL, updated_at = CURRENT_TIMESTAMP WHERE batch_id = ? AND commission_entry_id = ?').run(
      batchId,
      commission_entry_id
    );
    return { commission_entry_id, action, success: true };
  }

  return { commission_entry_id, action, success: false, message: 'Invalid action' };
}

/** Convert proposed changes to apply payloads (one action per change). */
export function changesToApplyPayloads(
  commission_entry_id: string,
  changes: Array<{
    action: ApplyChangePayload['action'];
    proposedValue?: string | number | null;
  }>
): ApplyChangePayload[] {
  const payloads: ApplyChangePayload[] = [];
  for (const c of changes) {
    const base = { commission_entry_id, action: c.action };
    switch (c.action) {
      case 'adjust_amount':
        payloads.push({ ...base, override_amount: c.proposedValue as number | null });
        break;
      case 'update_payment_date':
        payloads.push({ ...base, override_payment_date: c.proposedValue as string | null });
        break;
      case 'update_commission_rate':
        payloads.push({ ...base, override_commission_rate: c.proposedValue as number | null });
        break;
      case 'update_amount_claimed':
        payloads.push({ ...base, override_amount_collected: c.proposedValue as number | null });
        break;
      case 'add_note':
        payloads.push({ ...base, adjustment_note: c.proposedValue as string | null });
        break;
      case 'ignore_entry':
      case 'remove_entry':
        payloads.push(base);
        break;
      case 'override_to_renewal':
        payloads.push({ ...base, previous_deal_amount: c.proposedValue as number });
        break;
    }
  }
  return payloads;
}

/** Apply multiple changes sequentially (caller wraps in transaction). */
export async function applyChangesSequential(
  db: Db,
  batchId: string,
  batch: { bdr_id: string; status: string; payable_cutoff?: string | null; run_date?: string },
  changes: ApplyChangePayload[]
): Promise<ApplyChangeResult[]> {
  const results: ApplyChangeResult[] = [];
  for (const change of changes) {
    results.push(await applyBatchChangeLocal(db, batchId, batch, change));
  }
  return results;
}
