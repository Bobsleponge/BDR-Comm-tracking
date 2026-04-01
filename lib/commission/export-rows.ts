/**
 * Shared logic to build commission report export rows from batch items.
 * Used for snapshot (approve), export, and display.
 */

/** Supabase nested item shape from batch_items select */
export interface SupabaseBatchItem {
  override_amount?: number | null;
  override_payment_date?: string | null;
  override_commission_rate?: number | null;
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
}

export function buildExportRows(items: BatchItemRaw[]): ExportRow[] {
  const out = items.map((i) => {
    const originalAmount = i.original_amount ?? 0;
    const isAmountTbd = i.original_amount == null && i.amount_collected == null;
    const overrideAmount = i.override_amount;
    const amountCollected = i.amount_collected ?? 0;
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
}

/** Convert snapshot ExportRows to BatchItemDisplay for GET response */
export function snapshotRowsToBatchItems(rows: ExportRow[], batchId: string): BatchItemDisplay[] {
  return rows.map((r, idx) => ({
    id: `snapshot-${batchId}-${idx}`,
    commission_entry_id: '',
    override_amount: r.override_amount ? parseFloat(r.override_amount) : null,
    override_payment_date: r.payable_date || null,
    override_commission_rate: r.commission_pct ? parseFloat(r.commission_pct.replace('%', '')) / 100 : null,
    adjustment_note: null,
    amount: parseFloat(r.final_invoiced_amount || '0'),
    client_name: r.client_name,
    service_type: '',
    service_name: r.deal,
    commission_rate: r.commission_pct ? parseFloat(r.commission_pct.replace('%', '')) / 100 : null,
    billing_type: '',
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
  }));
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
    amount_collected: reObj?.amount_collected,
  };
}
