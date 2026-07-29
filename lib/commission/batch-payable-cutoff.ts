/**
 * Payable-through date on commission report batches.
 * Entries with effective payable date after the cutoff belong on a future report.
 */

export function effectivePayableDate(
  overridePaymentDate?: string | null,
  payableDate?: string | null,
  accrualDate?: string | null,
  month?: string | null
): string | null {
  const raw =
    overridePaymentDate ||
    payableDate ||
    accrualDate ||
    (month ? `${String(month).slice(0, 7)}-01` : null);
  if (!raw) return null;
  return String(raw).slice(0, 10);
}

export function isWithinPayableCutoff(effectiveDate: string | null, cutoff: string): boolean {
  return !!effectiveDate && effectiveDate <= cutoff;
}

export function resolveBatchPayableCutoff(batch: {
  payable_cutoff?: string | null;
  run_date: string;
}): string {
  if (batch.payable_cutoff && /^\d{4}-\d{2}-\d{2}$/.test(batch.payable_cutoff)) {
    return batch.payable_cutoff;
  }
  return batch.run_date;
}

export interface BatchItemPayableRow {
  commission_entry_id: string;
  override_payment_date?: string | null;
  payable_date?: string | null;
  accrual_date?: string | null;
  month?: string | null;
}

export function batchItemEffectiveDate(item: BatchItemPayableRow): string | null {
  return effectivePayableDate(
    item.override_payment_date,
    item.payable_date,
    item.accrual_date,
    item.month
  );
}

export function filterBatchItemsWithinCutoff<T extends BatchItemPayableRow>(
  items: T[],
  cutoff: string
): T[] {
  return items.filter((item) => isWithinPayableCutoff(batchItemEffectiveDate(item), cutoff));
}

/** Remove batch items (and invoiced_batch_id) when payable date is after the report cutoff. */
export function evictBatchItemsPastCutoffLocal(
  db: {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
      run: (...args: unknown[]) => unknown;
    };
  },
  batchId: string,
  cutoff: string
): string[] {
  const rows = db
    .prepare(
      `
    SELECT cbi.commission_entry_id, cbi.override_payment_date, ce.payable_date, ce.accrual_date, ce.month
    FROM commission_batch_items cbi
    JOIN commission_entries ce ON ce.id = cbi.commission_entry_id
    WHERE cbi.batch_id = ?
  `
    )
    .all(batchId) as BatchItemPayableRow[];

  const evicted: string[] = [];
  const clearInvoiced = db.prepare(
    `UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  );
  const deleteItem = db.prepare(
    `DELETE FROM commission_batch_items WHERE batch_id = ? AND commission_entry_id = ?`
  );

  for (const row of rows) {
    const effective = batchItemEffectiveDate(row);
    if (isWithinPayableCutoff(effective, cutoff)) continue;
    clearInvoiced.run(row.commission_entry_id);
    deleteItem.run(batchId, row.commission_entry_id);
    evicted.push(row.commission_entry_id);
  }

  return evicted;
}

export async function evictBatchItemsPastCutoffSupabase(
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, val: string) => Promise<{ data: BatchItemPayableRow[] | null }>;
      };
      update: (vals: Record<string, unknown>) => {
        eq: (col: string, val: string) => Promise<unknown>;
      };
      delete: () => {
        eq: (col: string, val: string) => {
          eq: (col2: string, val2: string) => Promise<unknown>;
        };
      };
    };
  },
  batchId: string,
  cutoff: string
): Promise<string[]> {
  const { data: rows } = await supabase
    .from('commission_batch_items')
    .select(
      'commission_entry_id, override_payment_date, commission_entries(payable_date, accrual_date, month)'
    )
    .eq('batch_id', batchId);

  const evicted: string[] = [];
  for (const row of rows || []) {
    const ce = (row as { commission_entries?: BatchItemPayableRow | BatchItemPayableRow[] })
      .commission_entries;
    const ceObj = Array.isArray(ce) ? ce[0] : ce;
    const effective = batchItemEffectiveDate({
      commission_entry_id: row.commission_entry_id,
      override_payment_date: row.override_payment_date,
      payable_date: ceObj?.payable_date,
      accrual_date: ceObj?.accrual_date,
      month: ceObj?.month,
    });
    if (isWithinPayableCutoff(effective, cutoff)) continue;
    await supabase
      .from('commission_entries')
      .update({ invoiced_batch_id: null })
      .eq('id', row.commission_entry_id);
    await supabase
      .from('commission_batch_items')
      .delete()
      .eq('batch_id', batchId)
      .eq('commission_entry_id', row.commission_entry_id);
    evicted.push(row.commission_entry_id);
  }
  return evicted;
}
