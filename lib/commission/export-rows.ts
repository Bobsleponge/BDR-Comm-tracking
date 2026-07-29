/**
 * Shared logic to build commission report export rows from batch items.
 * Used for snapshot (approve), export, and display.
 */

import { buildPaymentSequenceMapLocal, lookupPaymentSequence } from '@/lib/commission/enrich-payment-sequence';

/** Supabase nested item shape from batch_items select */
export interface SupabaseBatchItem {
  override_amount?: number | null;
  override_payment_date?: string | null;
  override_commission_rate?: number | null;
  override_amount_collected?: number | null;
  commission_entries?: {
    amount?: number;
    payable_date?: string | null;
    accrual_date?: string | null;
    deals?: { client_name?: string; service_type?: string; deal_value?: number; original_deal_value?: number; is_renewal?: boolean };
    revenue_events?: {
      billing_type?: string;
      collection_date?: string;
      amount_collected?: number;
      deal_services?: {
        service_name?: string;
        commission_rate?: number;
        is_renewal?: boolean;
        original_service_value?: number;
        commissionable_value?: number;
      };
    };
  };
}

export interface ExportRow {
  client_name: string;
  deal: string;
  payment_sequence: string;
  payable_date: string;
  amount_claimed_on: string;
  is_renewal: string;
  previous_deal_amount: string;
  new_deal_amount: string;
  commission_pct: string;
  original_commission: string;
  override_amount: string;
  final_invoiced_amount: string;
}

export interface BatchItemRaw {
  override_amount?: number | null;
  override_payment_date?: string | null;
  override_commission_rate?: number | null;
  override_amount_collected?: number | null;
  /** Revenue event amount before report override (for change summaries). */
  baseline_amount_collected?: number | null;
  original_amount?: number | null;
  payable_date?: string | null;
  accrual_date?: string | null;
  client_name?: string | null;
  service_type?: string | null;
  deal_value?: number | null;
  original_deal_value?: number | null;
  deal_is_renewal?: number | boolean | null;
  service_name?: string | null;
  commission_rate?: number | null;
  service_is_renewal?: number | boolean | null;
  original_service_value?: number | null;
  commissionable_value?: number | null;
  re_billing_type?: string | null;
  collection_date?: string | null;
  amount_collected?: number | null;
  revenue_event_id?: string | null;
  service_id?: string | null;
  service_billing_type?: string | null;
  contract_months?: number | null;
  contract_quarters?: number | null;
  service_completion_date?: string | null;
  /** Precomputed e.g. "3 of 12" */
  payment_sequence?: string | null;
  commission_entry_id?: string | null;
}

/** Batch item source row + ids/timestamps for approve-time snapshot (not exported to Excel). */
export interface SnapshotItemInput extends BatchItemRaw {
  commission_entry_id: string;
  adjustment_note?: string | null;
  /** From commission_batch_items.updated_at at approve time */
  batch_item_updated_at?: string | null;
}

export interface CommissionSnapshotRow extends ExportRow {
  commission_entry_id: string;
  adjustment_note: string | null;
  change_summary: string | null;
  adjusted_at: string | null;
  is_adjusted: boolean;
}

function normYyyyMmDd(s: string | null | undefined): string {
  if (s == null || s === '') return '';
  const t = String(s).trim();
  return t.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : t;
}

/** Effective amount claimed on for export/display (report override wins). */
export function effectiveAmountCollected(
  override: number | null | undefined,
  fromRevenue: number | null | undefined
): number | null {
  if (override != null && !Number.isNaN(Number(override))) return Number(override);
  if (fromRevenue != null && !Number.isNaN(Number(fromRevenue))) return Number(fromRevenue);
  return null;
}

/** Human-readable summary of overrides vs system values (UI only). */
export function buildChangeSummary(raw: SnapshotItemInput): string {
  const parts: string[] = [];
  const origAmt = raw.original_amount;
  const amtCollected = effectiveAmountCollected(raw.override_amount_collected, raw.amount_collected) ?? 0;
  const baseRate = raw.commission_rate != null ? Number(raw.commission_rate) : null;

  if (raw.override_amount_collected != null) {
    const baseline = raw.baseline_amount_collected ?? raw.amount_collected ?? 0;
    const claimed = Number(raw.override_amount_collected);
    if (baseline > 0 && Math.abs(claimed - Number(baseline)) >= 0.02) {
      parts.push(`Amount claimed on $${Number(baseline).toFixed(2)} → $${claimed.toFixed(2)}`);
    } else {
      parts.push(`Amount claimed on set to $${claimed.toFixed(2)}`);
    }
  }

  if (raw.override_amount != null) {
    const oa = Number(raw.override_amount);
    if (origAmt != null && Math.abs(oa - Number(origAmt)) >= 0.02) {
      parts.push(`Commission amount $${Number(origAmt).toFixed(2)} → $${oa.toFixed(2)}`);
    } else if (origAmt == null || Math.abs(oa - Number(origAmt)) >= 0.02) {
      parts.push(`Commission amount set to $${oa.toFixed(2)}`);
    }
  }

  if (raw.override_commission_rate != null && raw.override_amount == null) {
    const or = Number(raw.override_commission_rate);
    if (baseRate != null && Math.abs(or - baseRate) >= 1e-6) {
      parts.push(`Commission rate ${(baseRate * 100).toFixed(2)}% → ${(or * 100).toFixed(2)}%`);
    }
    if (amtCollected > 0 && origAmt != null) {
      const implied = amtCollected * or;
      if (Math.abs(implied - Number(origAmt)) >= 0.02) {
        parts.push(`Implied commission $${Number(origAmt).toFixed(2)} → $${implied.toFixed(2)}`);
      }
    }
  }

  if (raw.override_payment_date) {
    const baseline =
      normYyyyMmDd(raw.payable_date) ||
      normYyyyMmDd(raw.accrual_date) ||
      normYyyyMmDd(raw.collection_date);
    const op = normYyyyMmDd(raw.override_payment_date);
    if (op && baseline && op !== baseline) {
      parts.push(`Payable date ${baseline} → ${op}`);
    } else if (op) {
      parts.push(`Payable date ${op}`);
    }
  }

  let summary = parts.join('; ');
  if (!summary && (raw.override_amount != null || raw.override_payment_date || raw.override_commission_rate != null)) {
    summary = 'Adjusted on report';
  }
  if (!summary && raw.adjustment_note?.trim()) {
    summary = 'Note on report';
  }
  return summary;
}

export function computeSnapshotAdjustmentFields(raw: SnapshotItemInput): {
  change_summary: string | null;
  is_adjusted: boolean;
} {
  const change_summary = buildChangeSummary(raw);
  const is_adjusted =
    change_summary !== '' ||
    !!raw.adjustment_note?.trim() ||
    raw.override_amount != null ||
    raw.override_amount_collected != null ||
    !!raw.override_payment_date ||
    raw.override_commission_rate != null;
  return {
    change_summary: is_adjusted ? change_summary || 'Adjusted on report' : null,
    is_adjusted,
  };
}

export function buildCommissionSnapshotRows(items: SnapshotItemInput[]): CommissionSnapshotRow[] {
  const exportRows = buildExportRows(items);
  return exportRows.map((er, idx) => {
    const raw = items[idx];
    const { change_summary, is_adjusted } = computeSnapshotAdjustmentFields(raw);
    return {
      ...er,
      commission_entry_id: raw.commission_entry_id,
      adjustment_note: raw.adjustment_note ?? null,
      change_summary,
      adjusted_at: raw.batch_item_updated_at ?? null,
      is_adjusted,
    };
  });
}

/** Strip UI-only fields before CSV/XLSX export. */
export function snapshotRowsToExportRows(rows: Array<ExportRow | CommissionSnapshotRow>): ExportRow[] {
  return rows.map((r) => ({
    client_name: r.client_name,
    deal: r.deal,
    payment_sequence: r.payment_sequence ?? '',
    payable_date: r.payable_date,
    amount_claimed_on: r.amount_claimed_on,
    is_renewal: r.is_renewal,
    previous_deal_amount: r.previous_deal_amount,
    new_deal_amount: r.new_deal_amount,
    commission_pct: r.commission_pct,
    original_commission: r.original_commission,
    override_amount: r.override_amount,
    final_invoiced_amount: r.final_invoiced_amount,
  }));
}

/** Per-entry metadata from approved report snapshots (for commission list highlighting). First matching snapshot wins. */
export type ReportAdjustmentMeta = {
  batch_id: string;
  change_summary: string | null;
  adjusted_at: string | null;
};

/** Merge snapshot row array into adjustment map by commission_entry_id (skips legacy rows without id). */
export function mergeSnapshotsIntoAdjustmentMap(
  snapshotRowsParsed: unknown,
  batch_id: string,
  into: Map<string, ReportAdjustmentMeta>
): void {
  if (!Array.isArray(snapshotRowsParsed)) return;
  for (const row of snapshotRowsParsed as Array<Partial<CommissionSnapshotRow> & ExportRow>) {
    const ceId = row.commission_entry_id;
    if (!ceId || into.has(ceId)) continue;
    const isAdj =
      row.is_adjusted === true ||
      !!(row.adjustment_note && String(row.adjustment_note).trim()) ||
      !!(row.override_amount && String(row.override_amount).trim());
    if (!isAdj) continue;
    into.set(ceId, {
      batch_id,
      change_summary: (row.change_summary as string | null) ?? null,
      adjusted_at: (row.adjusted_at as string | null) ?? null,
    });
  }
}

export function buildExportRows(items: BatchItemRaw[]): ExportRow[] {
  const out = items.map((i) => {
    const originalAmount = i.original_amount ?? 0;
    const isAmountTbd = i.original_amount == null && effectiveAmountCollected(i.override_amount_collected, i.amount_collected) == null;
    const overrideAmount = i.override_amount;
    const amountCollected = effectiveAmountCollected(i.override_amount_collected, i.amount_collected) ?? 0;
    const displayRate = i.override_commission_rate ?? i.commission_rate;
    let finalAmount = overrideAmount;
    if (finalAmount == null && i.override_commission_rate != null && amountCollected > 0) {
      finalAmount = amountCollected * i.override_commission_rate;
    }
    if (finalAmount == null) finalAmount = isAmountTbd ? 0 : originalAmount;
    const commissionPct = displayRate != null ? `${(Number(displayRate) * 100).toFixed(2)}%` : '';
    const dealLabel = i.service_name || i.service_type || 'Deal';
    const paymentDate = i.override_payment_date ?? i.payable_date ?? i.accrual_date ?? i.collection_date ?? '';
    const isRenewal = !!(
      i.service_is_renewal === 1 ||
      i.service_is_renewal === true ||
      i.deal_is_renewal === 1 ||
      i.deal_is_renewal === true ||
      i.re_billing_type === 'renewal'
    );

    let previousDealAmount = '';
    let newDealAmount = '';
    let derivedUplift = 0;
    if (isRenewal) {
      let prev = 0,
        nw = 0;
      const storedNew = i.commissionable_value ?? i.deal_value ?? 0;
      const storedPrev = i.original_service_value ?? i.original_deal_value;
      const uplift = Number(i.amount_collected ?? 0);
      if (i.re_billing_type === 'renewal' && uplift > 0 && storedNew > 0) {
        const numNew = Number(storedNew);
        if (storedPrev == null || Number(storedPrev) === numNew) {
          prev = Math.max(0, numNew - uplift);
          nw = numNew;
        } else {
          prev = Number(storedPrev ?? 0);
          nw = numNew;
        }
      } else if (i.original_service_value != null || i.commissionable_value != null) {
        prev = Number(i.original_service_value ?? 0);
        nw = Number(i.commissionable_value ?? 0);
      } else {
        prev = Number(i.original_deal_value ?? 0);
        nw = Number(i.deal_value ?? 0);
      }
      previousDealAmount = prev > 0 ? prev.toFixed(2) : '';
      newDealAmount = nw > 0 ? nw.toFixed(2) : '';
      derivedUplift = nw > prev ? nw - prev : 0;
    }

    const claimedOn =
      isRenewal && derivedUplift > 0
        ? derivedUplift.toFixed(2)
        : amountCollected > 0
          ? amountCollected.toFixed(2)
          : '';
    return {
      client_name: i.client_name ?? '',
      deal: dealLabel,
      payment_sequence: i.payment_sequence ?? '',
      payable_date: paymentDate,
      amount_claimed_on: claimedOn,
      is_renewal: isRenewal ? 'Yes' : 'No',
      previous_deal_amount: previousDealAmount,
      new_deal_amount: newDealAmount,
      commission_pct: commissionPct,
      original_commission: isAmountTbd ? 'TBD' : originalAmount.toFixed(2),
      override_amount: overrideAmount != null ? overrideAmount.toFixed(2) : '',
      final_invoiced_amount: isAmountTbd ? 'TBD' : finalAmount.toFixed(2),
    };
  });
  // #region agent log
  if (items.length > 0 && typeof fetch === 'function') {
    const sample = out.slice(0, 10).map((r, idx) => {
      const i = items[idx];
      const rate = i?.override_commission_rate ?? i?.commission_rate;
      const impliedFromCommission = rate && i?.original_amount ? (i.original_amount / rate).toFixed(2) : null;
      const collected = i?.amount_collected ?? 0;
      return {
        client: r.client_name,
        amount_collected: collected,
        amount_claimed_on: r.amount_claimed_on,
        original_commission: i?.original_amount,
        rate,
        impliedFromCommission,
        mismatch: impliedFromCommission && collected > 0 && Math.abs(parseFloat(impliedFromCommission) - collected) > 0.01,
        billing: i?.re_billing_type,
      };
    });
    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'export-rows.ts:amount_claimed_on',message:'Amount claimed check',data:{total:items.length,sample},timestamp:Date.now(),hypothesisId:'amount_claimed'})}).catch(()=>{});
  }
  // #endregion
  return out;
}

/** Batch item shape for GET response (matches frontend BatchItem) */
export interface BatchItemDisplay {
  id: string;
  commission_entry_id: string;
  override_amount: number | null;
  override_payment_date: string | null;
  override_commission_rate: number | null;
  adjustment_note: string | null;
  amount: number;
  client_name: string;
  service_type: string;
  service_name: string;
  commission_rate: number | null;
  billing_type: string;
  payment_sequence: string;
  collection_date: string;
  amount_collected: number;
  commissionable_value: number | null;
  is_renewal: boolean;
  previous_deal_amount: number | null;
  new_deal_amount: number | null;
  payable_date: string | null;
  accrual_date: string | null;
  month: string;
  deal_id: string;
  change_summary?: string | null;
  adjusted_at?: string | null;
  is_adjusted?: boolean;
}

function exportRowToBatchItemDisplay(r: ExportRow, batchId: string, entryIdSuffix: string): BatchItemDisplay {
  const finalRaw = parseFloat(String(r.final_invoiced_amount));
  const amount = Number.isFinite(finalRaw) ? finalRaw : 0;
  return {
    id: `snapshot-${batchId}-${entryIdSuffix}`,
    commission_entry_id: '',
    override_amount: r.override_amount ? parseFloat(r.override_amount) : null,
    override_payment_date: r.payable_date || null,
    override_commission_rate: r.commission_pct ? parseFloat(r.commission_pct.replace('%', '')) / 100 : null,
    adjustment_note: null,
    amount,
    client_name: r.client_name,
    service_type: '',
    service_name: r.deal,
    commission_rate: r.commission_pct ? parseFloat(r.commission_pct.replace('%', '')) / 100 : null,
    billing_type: '',
    payment_sequence: r.payment_sequence || '1 of 1',
    collection_date: r.amount_claimed_on || '',
    amount_collected: r.amount_claimed_on ? parseFloat(r.amount_claimed_on) : 0,
    commissionable_value: r.new_deal_amount ? parseFloat(r.new_deal_amount) : null,
    is_renewal: r.is_renewal === 'Yes',
    previous_deal_amount: r.previous_deal_amount ? parseFloat(r.previous_deal_amount) : null,
    new_deal_amount: r.new_deal_amount ? parseFloat(r.new_deal_amount) : null,
    payable_date: r.payable_date || null,
    accrual_date: null,
    month: r.payable_date ? r.payable_date.slice(0, 7) : '',
    deal_id: '',
    is_adjusted: false,
  };
}

/** Convert snapshot rows to BatchItemDisplay for GET response (supports legacy ExportRow-only snapshots). */
export function snapshotRowsToBatchItems(rows: Array<ExportRow | CommissionSnapshotRow>, batchId: string): BatchItemDisplay[] {
  return rows.map((r, idx) => {
    const ext = r as CommissionSnapshotRow;
    const hasMeta = typeof ext.commission_entry_id === 'string' && ext.commission_entry_id.length > 0;
    const base = exportRowToBatchItemDisplay(r, batchId, hasMeta ? ext.commission_entry_id : String(idx));
    if (!hasMeta) {
      return base;
    }
    return {
      ...base,
      id: `snapshot-${batchId}-${ext.commission_entry_id}`,
      commission_entry_id: ext.commission_entry_id,
      adjustment_note: ext.adjustment_note ?? null,
      override_amount: r.override_amount && r.override_amount !== '' ? parseFloat(r.override_amount) : null,
      payable_date: r.payable_date || base.payable_date,
      change_summary: ext.change_summary ?? null,
      adjusted_at: ext.adjusted_at ?? null,
      is_adjusted: ext.is_adjusted ?? false,
    };
  });
}

/** Flatten Supabase nested batch item to BatchItemRaw */
export function flattenSupabaseItem(item: SupabaseBatchItem): BatchItemRaw {
  const ce = item.commission_entries;
  const ceObj = Array.isArray(ce) ? ce[0] : ce;
  const deal = ceObj?.deals;
  const dealObj = Array.isArray(deal) ? deal[0] : deal;
  const re = ceObj?.revenue_events;
  const reObj = Array.isArray(re) ? re[0] : re;
  const ds = reObj?.deal_services;
  const dsObj = Array.isArray(ds) ? ds[0] : ds;
  return {
    override_amount: item.override_amount,
    override_payment_date: item.override_payment_date,
    override_commission_rate: item.override_commission_rate,
    override_amount_collected: item.override_amount_collected,
    baseline_amount_collected: reObj?.amount_collected,
    original_amount: ceObj?.amount != null ? ceObj.amount : null,
    payable_date: ceObj?.payable_date,
    accrual_date: ceObj?.accrual_date,
    client_name: dealObj?.client_name,
    service_type: dealObj?.service_type,
    deal_value: dealObj?.deal_value,
    original_deal_value: dealObj?.original_deal_value,
    deal_is_renewal: dealObj?.is_renewal,
    service_name: dsObj?.service_name,
    commission_rate: dsObj?.commission_rate,
    service_is_renewal: dsObj?.is_renewal,
    original_service_value: dsObj?.original_service_value,
    commissionable_value: dsObj?.commissionable_value,
    re_billing_type: reObj?.billing_type,
    collection_date: reObj?.collection_date,
    amount_collected: effectiveAmountCollected(item.override_amount_collected, reObj?.amount_collected),
  };
}

/** Attach payment_sequence labels to batch export rows (local DB). */
export function attachPaymentSequencesToBatchItems(
  db: import('better-sqlite3').Database,
  items: BatchItemRaw[]
): BatchItemRaw[] {
  const lines = items.map((i, idx) => ({
    commission_entry_id: i.commission_entry_id ?? `batch-row-${idx}`,
    revenue_event_id: i.revenue_event_id ?? null,
    service_id: i.service_id ?? null,
  }));
  const map = buildPaymentSequenceMapLocal(db, lines);
  return items.map((i, idx) => {
    const entryKey = i.commission_entry_id ?? `batch-row-${idx}`;
    return {
      ...i,
      payment_sequence: lookupPaymentSequence(map, i.revenue_event_id ?? null, entryKey).label,
    };
  });
}
