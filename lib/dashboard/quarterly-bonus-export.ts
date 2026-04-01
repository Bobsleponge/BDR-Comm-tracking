import { format } from 'date-fns';
import { getLocalDB } from '@/lib/db/local-db';

export const QUARTERLY_BONUS_RATE = 0.025;

export type QuarterlyBonusReportType = 'payable' | 'cash' | 'closed_deals';

/** Cap payable_date at min(quarterEnd, maxPayableDateInclusive) — use for bonus “through today” within quarter. */
export type PayableBonusFetchOptions = {
  maxPayableDateInclusive?: string;
};

function payableUpperBound(quarterEndStr: string, options?: PayableBonusFetchOptions): string {
  if (!options?.maxPayableDateInclusive) return quarterEndStr;
  return quarterEndStr <= options.maxPayableDateInclusive ? quarterEndStr : options.maxPayableDateInclusive;
}

export interface QuarterlyBonusMeta {
  quarterlyTarget: number;
  revenueCollectedForTarget: number;
  bonusEligible: boolean;
  achievedPercent: number;
}

/** Payable-date basis — matches dashboard `projectedQuarterlyBonus` / `quarterlyProgressByQuarter[].bonus`. */
export interface PayableBonusRow {
  client_name: string;
  deal: string;
  payable_date: string;
  collection_date: string;
  billing_type?: string;
  entry_commission: string;
  attributed_revenue: string;
  bonus_at_2_5: string;
  group_month: string;
}

/** Closed-won deal value basis — matches `quarterlyCommissionOnClosedDeals`. */
export interface ClosedDealsBonusRow {
  client_name: string;
  deal: string;
  is_renewal: string;
  base_amount: string;
  rate_pct: string;
  basis_commission: string;
  group_deal_id: string;
}

export function attributedRevenueFromEntry(
  ceAmount: number,
  reId: string | null | undefined,
  amountCollected: number | null | undefined
): number {
  if (reId && amountCollected != null) return Number(amountCollected);
  return ceAmount / QUARTERLY_BONUS_RATE;
}

// ——— Local SQLite ———

type LocalDb = ReturnType<typeof getLocalDB>;

export function loadQuarterlyBonusMetaLocal(
  db: LocalDb,
  bdrId: string,
  quarterKey: string,
  quarterStartStr: string,
  quarterEndStr: string,
  todayStr: string
): QuarterlyBonusMeta {
  const rules = db
    .prepare('SELECT quarterly_target FROM commission_rules ORDER BY updated_at DESC LIMIT 1')
    .get() as { quarterly_target: number } | undefined;
  const defaultTarget = rules?.quarterly_target ?? 75000;
  const perf = db
    .prepare(
      `
    SELECT qp.revenue_collected, qp.achieved_percent, qp.bonus_eligible, qt.target_revenue
    FROM quarterly_performance qp
    LEFT JOIN quarterly_targets qt ON qp.quarter = qt.quarter AND qp.bdr_id = qt.bdr_id
    WHERE qp.bdr_id = ? AND qp.quarter = ?
  `
    )
    .get(bdrId, quarterKey) as
    | {
        revenue_collected: number;
        achieved_percent: number;
        bonus_eligible: number;
        target_revenue: number | null;
      }
    | undefined;
  const cashTotal = db
    .prepare(
      `
    SELECT COALESCE(SUM(re.amount_collected), 0) as total
    FROM revenue_events re
    INNER JOIN deals d ON re.deal_id = d.id
    WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ?
    AND re.commissionable = 1
    AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
  `
    )
    .get(bdrId, quarterStartStr, quarterEndStr, todayStr) as { total: number };
  const target = perf?.target_revenue ?? defaultTarget;
  const rev = Number(cashTotal?.total ?? 0);
  return {
    quarterlyTarget: target,
    revenueCollectedForTarget: rev,
    bonusEligible: !!perf?.bonus_eligible,
    achievedPercent: target > 0 ? Number(((rev / target) * 100).toFixed(2)) : 0,
  };
}

export function fetchPayableBonusRowsLocal(
  db: LocalDb,
  bdrId: string,
  quarterStartStr: string,
  quarterEndStr: string,
  options?: PayableBonusFetchOptions
): { rows: PayableBonusRow[]; totalAttributedRevenue: number; totalBonus: number; totalCommission: number } {
  const endCap = payableUpperBound(quarterEndStr, options);
  const raw = db
    .prepare(
      `
    SELECT
      ce.amount as ce_amount,
      ce.payable_date,
      re.id as re_id,
      re.collection_date,
      re.billing_type,
      re.amount_collected,
      d.client_name,
      d.service_type,
      ds.service_name
    FROM commission_entries ce
    INNER JOIN deals d ON ce.deal_id = d.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
    WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
      AND ce.payable_date >= ? AND ce.payable_date <= ?
      AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date OR re.id IS NULL)
    ORDER BY ce.payable_date, ce.id
  `
    )
    .all(bdrId, quarterStartStr, endCap) as Array<{
    ce_amount: number;
    payable_date: string;
    re_id: string | null;
    collection_date: string | null;
    billing_type: string | null;
    amount_collected: number | null;
    client_name: string;
    service_type: string;
    service_name: string | null;
  }>;

  let totalAttributedRevenue = 0;
  let totalCommission = 0;
  const rows: PayableBonusRow[] = [];
  for (const r of raw) {
    const ceAmt = Number(r.ce_amount ?? 0);
    totalCommission += ceAmt;
    const rev = attributedRevenueFromEntry(ceAmt, r.re_id, r.amount_collected);
    const bonus = rev * QUARTERLY_BONUS_RATE;
    totalAttributedRevenue += rev;
    const pd = (r.payable_date || '').split('T')[0];
    const groupMonth = pd.length >= 7 ? pd.substring(0, 7) : '';
    rows.push({
      client_name: r.client_name ?? '',
      deal: r.service_name || r.service_type || 'Deal',
      payable_date: pd,
      collection_date: (r.collection_date || '').split('T')[0] ?? '',
      billing_type: r.billing_type || undefined,
      entry_commission: ceAmt.toFixed(2),
      attributed_revenue: rev.toFixed(2),
      bonus_at_2_5: bonus.toFixed(2),
      group_month: groupMonth,
    });
  }
  const totalBonus = totalAttributedRevenue * QUARTERLY_BONUS_RATE;
  return {
    rows,
    totalAttributedRevenue: Number(totalAttributedRevenue.toFixed(2)),
    totalBonus: Number(totalBonus.toFixed(2)),
    totalCommission: Number(totalCommission.toFixed(2)),
  };
}

export function fetchClosedDealsBonusRowsLocal(
  db: LocalDb,
  bdrId: string,
  quarterStartStr: string,
  quarterEndStr: string
): { rows: ClosedDealsBonusRow[]; totalBasisCommission: number; totalBaseAmount: number } {
  const defaultRate = QUARTERLY_BONUS_RATE;
  const dealIdsWithPayable = db
    .prepare(
      `
    SELECT DISTINCT ce.deal_id
    FROM commission_entries ce
    INNER JOIN deals d ON ce.deal_id = d.id
    WHERE ce.bdr_id = ? AND ce.status != 'cancelled'
      AND ce.payable_date >= ? AND ce.payable_date <= ?
      AND d.cancellation_date IS NULL
  `
    )
    .all(bdrId, quarterStartStr, quarterEndStr) as { deal_id: string }[];
  const qDealIds = [...new Set(dealIdsWithPayable.map((r) => r.deal_id))];

  const rows: ClosedDealsBonusRow[] = [];
  let totalBasisCommission = 0;
  let totalBaseAmount = 0;

  if (qDealIds.length === 0) {
    return { rows, totalBasisCommission: 0, totalBaseAmount: 0 };
  }

  const placeholders = qDealIds.map(() => '?').join(',');
  const services = db
    .prepare(
      `
    SELECT ds.deal_id, ds.service_name, ds.commissionable_value, ds.commission_rate, ds.original_service_value, ds.is_renewal,
           d.client_name, d.service_type, d.original_deal_value, d.deal_value, d.is_renewal as deal_is_renewal
    FROM deal_services ds
    INNER JOIN deals d ON ds.deal_id = d.id
    WHERE ds.deal_id IN (${placeholders})
  `
    )
    .all(...qDealIds) as Array<{
    deal_id: string;
    service_name: string | null;
    commissionable_value: number | null;
    commission_rate: number | null;
    original_service_value: number | null;
    is_renewal: number | null;
    client_name: string;
    service_type: string;
    original_deal_value: number | null;
    deal_value: number | null;
    deal_is_renewal: number | null;
  }>;

  const dealTotals = new Map<string, number>();
  for (const svc of services) {
    const cv = svc.commissionable_value ?? 0;
    dealTotals.set(svc.deal_id, (dealTotals.get(svc.deal_id) ?? 0) + cv);
  }

  for (const svc of services) {
    const isRenewal =
      svc.is_renewal === 1 || (svc.deal_is_renewal === 1 && (svc.original_deal_value ?? 0) > 0);
    const rate = svc.commission_rate ?? defaultRate;
    const commVal = Number(svc.commissionable_value ?? 0);
    const origSvc = Number(svc.original_service_value ?? 0);
    const origDeal = svc.original_deal_value ?? 0;
    const dealVal = svc.deal_value ?? 0;
    const totalDealComm = dealTotals.get(svc.deal_id) ?? 0;

    let baseAmount: number;
    if (commVal > 0) {
      if (isRenewal) {
        const origForSvc =
          origSvc > 0 ? origSvc : origDeal > 0 && totalDealComm > 0 ? (origDeal * commVal) / totalDealComm : 0;
        baseAmount = Math.max(0, commVal - origForSvc);
      } else {
        baseAmount = commVal;
      }
    } else {
      baseAmount = isRenewal ? (origDeal > 0 ? Math.max(0, dealVal - origDeal) : 0) : dealVal;
    }
    const basisCommission = baseAmount * rate;
    totalBasisCommission += basisCommission;
    totalBaseAmount += baseAmount;
    rows.push({
      client_name: svc.client_name ?? '',
      deal: svc.service_name || svc.service_type || 'Deal',
      is_renewal: isRenewal ? 'Yes' : 'No',
      base_amount: baseAmount.toFixed(2),
      rate_pct: `${(rate * 100).toFixed(2)}%`,
      basis_commission: basisCommission.toFixed(2),
      group_deal_id: svc.deal_id,
    });
  }

  const dealsWithServices = new Set(services.map((s) => s.deal_id));
  for (const dealId of qDealIds) {
    if (dealsWithServices.has(dealId)) continue;
    const deal = db
      .prepare('SELECT client_name, service_type, deal_value, original_deal_value, is_renewal FROM deals WHERE id = ?')
      .get(dealId) as
      | {
          client_name: string;
          service_type: string;
          deal_value: number;
          original_deal_value: number | null;
          is_renewal: number;
        }
      | undefined;
    if (!deal) continue;
    const origDeal = deal.original_deal_value ?? 0;
    const dealVal = deal.deal_value ?? 0;
    const isRenewal = deal.is_renewal === 1 && origDeal > 0;
    const baseAmount = isRenewal ? Math.max(0, dealVal - origDeal) : dealVal;
    const basisCommission = baseAmount * defaultRate;
    totalBasisCommission += basisCommission;
    totalBaseAmount += baseAmount;
    rows.push({
      client_name: deal.client_name ?? '',
      deal: deal.service_type || 'Deal',
      is_renewal: isRenewal ? 'Yes' : 'No',
      base_amount: baseAmount.toFixed(2),
      rate_pct: `${(defaultRate * 100).toFixed(2)}%`,
      basis_commission: basisCommission.toFixed(2),
      group_deal_id: dealId,
    });
  }

  return {
    rows,
    totalBasisCommission: Number(totalBasisCommission.toFixed(2)),
    totalBaseAmount: Number(totalBaseAmount.toFixed(2)),
  };
}

export function groupPayableRowsByMonth(rows: PayableBonusRow[]) {
  const rowsByMonth: Record<string, PayableBonusRow[]> = {};
  for (const r of rows) {
    const m = r.group_month || 'unknown';
    if (!rowsByMonth[m]) rowsByMonth[m] = [];
    rowsByMonth[m].push(r);
  }
  const sortedMonths = Object.keys(rowsByMonth).sort();
  return { rowsByMonth, sortedMonths };
}

export function groupClosedDealRowsByDealId(rows: ClosedDealsBonusRow[]) {
  const byDeal: Record<string, ClosedDealsBonusRow[]> = {};
  for (const r of rows) {
    const id = r.group_deal_id;
    if (!byDeal[id]) byDeal[id] = [];
    byDeal[id].push(r);
  }
  const sortedIds = Object.keys(byDeal).sort();
  return { rowsByDeal: byDeal, sortedDealIds: sortedIds };
}

export interface QuarterlyPayableProgressItem {
  revenue: number;
  commission: number;
  bonus: number;
  target: number;
  achievedPercent: number;
}

function quarterFromDateStr(dateStr: string): string | null {
  if (!dateStr || dateStr.length < 10) return null;
  const year = dateStr.substring(0, 4);
  const month = Number(dateStr.substring(5, 7));
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  const quarter = Math.ceil(month / 3);
  return `${year}-Q${quarter}`;
}

export function buildQuarterlyPayableProgressFromRows(
  rows: PayableBonusRow[],
  year: number,
  todayStr: string,
  targetPerQuarter: number
): {
  projectedBonusByQuarter: Record<string, number>;
  progressByQuarter: Record<string, QuarterlyPayableProgressItem>;
} {
  const quarterKeys = [`${year}-Q1`, `${year}-Q2`, `${year}-Q3`, `${year}-Q4`];
  const fullRevenueByQuarter: Record<string, number> = Object.fromEntries(quarterKeys.map((q) => [q, 0])) as Record<string, number>;
  const throughTodayRevenueByQuarter: Record<string, number> = Object.fromEntries(quarterKeys.map((q) => [q, 0])) as Record<string, number>;

  for (const row of rows) {
    const q = quarterFromDateStr(row.payable_date);
    if (!q || !(q in fullRevenueByQuarter)) continue;
    const revenue = Number.parseFloat(row.attributed_revenue || '0') || 0;
    fullRevenueByQuarter[q] += revenue;
    if (row.payable_date <= todayStr) {
      throughTodayRevenueByQuarter[q] += revenue;
    }
  }

  const projectedBonusByQuarter: Record<string, number> = Object.fromEntries(quarterKeys.map((q) => [q, 0])) as Record<string, number>;
  const progressByQuarter: Record<string, QuarterlyPayableProgressItem> = Object.fromEntries(
    quarterKeys.map((q) => [q, { revenue: 0, commission: 0, bonus: 0, target: targetPerQuarter, achievedPercent: 0 }])
  ) as Record<string, QuarterlyPayableProgressItem>;

  for (const q of quarterKeys) {
    const fullRevenue = fullRevenueByQuarter[q];
    const throughTodayRevenue = throughTodayRevenueByQuarter[q];
    const throughTodayBonus = throughTodayRevenue * QUARTERLY_BONUS_RATE;

    projectedBonusByQuarter[q] = Number((fullRevenue * QUARTERLY_BONUS_RATE).toFixed(2));
    progressByQuarter[q] = {
      revenue: Number(throughTodayRevenue.toFixed(2)),
      commission: Number(throughTodayBonus.toFixed(2)),
      bonus: Number(throughTodayBonus.toFixed(2)),
      target: targetPerQuarter,
      achievedPercent:
        targetPerQuarter > 0 ? Number(((throughTodayRevenue / targetPerQuarter) * 100).toFixed(2)) : 0,
    };
  }

  return { projectedBonusByQuarter, progressByQuarter };
}

export async function loadQuarterlyBonusMetaSupabase(
  supabase: any,
  bdrId: string,
  quarterKey: string,
  quarterStartStr: string,
  quarterEndStr: string,
  todayStr: string
): Promise<QuarterlyBonusMeta> {
  const { data: rules } = await supabase
    .from('commission_rules')
    .select('quarterly_target')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const defaultTarget = rules?.quarterly_target ?? 75000;
  const { data: perf } = await supabase
    .from('quarterly_performance')
    .select('revenue_collected, achieved_percent, bonus_eligible, quarterly_targets(target_revenue)')
    .eq('bdr_id', bdrId)
    .eq('quarter', quarterKey)
    .maybeSingle();
  const { data: revRows } = await supabase
    .from('revenue_events')
    .select('amount_collected, collection_date, deals!inner(cancellation_date)')
    .eq('bdr_id', bdrId)
    .gte('collection_date', quarterStartStr)
    .lte('collection_date', quarterEndStr)
    .lte('collection_date', todayStr)
    .eq('commissionable', true);
  const filtered = (revRows || []).filter((e: { collection_date?: string; deals?: unknown }) => {
    const d = Array.isArray(e.deals) ? e.deals[0] : e.deals;
    const cancel = (d as { cancellation_date?: string } | null)?.cancellation_date;
    return !cancel || (e.collection_date && e.collection_date < cancel);
  });
  const rev = filtered.reduce(
    (s: number, e: { amount_collected?: number }) => s + Number(e.amount_collected || 0),
    0
  );
  const qt = perf?.quarterly_targets;
  const targetObj = Array.isArray(qt) ? qt[0] : qt;
  const target = targetObj?.target_revenue ?? defaultTarget;
  return {
    quarterlyTarget: target,
    revenueCollectedForTarget: Number(rev.toFixed(2)),
    bonusEligible: !!perf?.bonus_eligible,
    achievedPercent: target > 0 ? Number(((rev / target) * 100).toFixed(2)) : 0,
  };
}

export async function fetchPayableBonusRowsSupabase(
  supabase: any,
  bdrId: string,
  quarterStartStr: string,
  quarterEndStr: string,
  options?: PayableBonusFetchOptions
): Promise<{
  rows: PayableBonusRow[];
  totalAttributedRevenue: number;
  totalBonus: number;
  totalCommission: number;
}> {
  const endCap = payableUpperBound(quarterEndStr, options);
  const { data: raw } = await supabase
    .from('commission_entries')
    .select(
      `
      amount,
      payable_date,
      deals(client_name, service_type, cancellation_date),
      revenue_events(id, amount_collected, billing_type, collection_date, deal_services(service_name))
    `
    )
    .eq('bdr_id', bdrId)
    .neq('status', 'cancelled')
    .gte('payable_date', quarterStartStr)
    .lte('payable_date', endCap);

  let totalAttributedRevenue = 0;
  let totalCommission = 0;
  const rows: PayableBonusRow[] = [];
  for (const row of raw || []) {
    const dealObj = Array.isArray(row.deals) ? row.deals[0] : row.deals;
    const revE = Array.isArray(row.revenue_events) ? row.revenue_events[0] : row.revenue_events;
    const cancel = dealObj?.cancellation_date;
    const collDate = revE?.collection_date;
    if (cancel && collDate && collDate >= cancel) continue;
    const ceAmt = Number(row.amount ?? 0);
    totalCommission += ceAmt;
    const revAmt = attributedRevenueFromEntry(ceAmt, revE?.id, revE?.amount_collected);
    const bonus = revAmt * QUARTERLY_BONUS_RATE;
    totalAttributedRevenue += revAmt;
    const pd = (row.payable_date || '').toString().split('T')[0];
    const groupMonth = pd.length >= 7 ? pd.substring(0, 7) : '';
    const ds = revE?.deal_services;
    const dso = Array.isArray(ds) ? ds[0] : ds;
    rows.push({
      client_name: dealObj?.client_name ?? '',
      deal: dso?.service_name || dealObj?.service_type || 'Deal',
      payable_date: pd,
      collection_date: (revE?.collection_date || '').toString().split('T')[0] ?? '',
      billing_type: revE?.billing_type || undefined,
      entry_commission: ceAmt.toFixed(2),
      attributed_revenue: revAmt.toFixed(2),
      bonus_at_2_5: bonus.toFixed(2),
      group_month: groupMonth,
    });
  }
  const totalBonus = totalAttributedRevenue * QUARTERLY_BONUS_RATE;
  return {
    rows,
    totalAttributedRevenue: Number(totalAttributedRevenue.toFixed(2)),
    totalBonus: Number(totalBonus.toFixed(2)),
    totalCommission: Number(totalCommission.toFixed(2)),
  };
}

export async function fetchClosedDealsBonusRowsSupabase(
  supabase: any,
  bdrId: string,
  quarterStartStr: string,
  quarterEndStr: string
): Promise<{ rows: ClosedDealsBonusRow[]; totalBasisCommission: number; totalBaseAmount: number }> {
  const defaultRate = QUARTERLY_BONUS_RATE;
  const { data: ceRows } = await supabase
    .from('commission_entries')
    .select('deal_id, deals!inner(cancellation_date)')
    .eq('bdr_id', bdrId)
    .neq('status', 'cancelled')
    .gte('payable_date', quarterStartStr)
    .lte('payable_date', quarterEndStr);

  const dealIdSet = new Set<string>();
  for (const row of ceRows || []) {
    const d = Array.isArray(row.deals) ? row.deals[0] : row.deals;
    if (d?.cancellation_date) continue;
    if (row.deal_id) dealIdSet.add(row.deal_id);
  }
  const qDealIds = [...dealIdSet];

  const rows: ClosedDealsBonusRow[] = [];
  let totalBasisCommission = 0;
  let totalBaseAmount = 0;
  if (qDealIds.length === 0) {
    return { rows, totalBasisCommission: 0, totalBaseAmount: 0 };
  }

  const { data: dealServices } = await supabase
    .from('deal_services')
    .select(
      'deal_id, commissionable_value, commission_rate, original_service_value, is_renewal, service_name, deals(original_deal_value, deal_value, is_renewal, client_name, service_type)'
    )
    .in('deal_id', qDealIds);

  const services = (dealServices || []) as Array<{
    deal_id: string;
    commissionable_value: number | null;
    commission_rate: number | null;
    original_service_value: number | null;
    is_renewal: boolean | number | null;
    service_name: string | null;
    deals: {
      original_deal_value: number | null;
      deal_value: number;
      is_renewal: boolean | number;
      client_name: string;
      service_type: string;
    } | null;
  }>;

  const dealTotals = new Map<string, number>();
  for (const svc of services) {
    const cv = svc.commissionable_value ?? 0;
    dealTotals.set(svc.deal_id, (dealTotals.get(svc.deal_id) ?? 0) + cv);
  }

  for (const svc of services) {
    const dealObj = Array.isArray(svc.deals) ? svc.deals[0] : svc.deals;
    const origDeal = dealObj?.original_deal_value ?? 0;
    const dealVal = dealObj?.deal_value ?? 0;
    const dealIsRenewal = dealObj?.is_renewal === true || dealObj?.is_renewal === 1;
    const isRenewal =
      svc.is_renewal === true || svc.is_renewal === 1 || (dealIsRenewal && origDeal > 0);
    const rate = svc.commission_rate ?? defaultRate;
    const commVal = Number(svc.commissionable_value ?? 0);
    const origSvc = Number(svc.original_service_value ?? 0);
    const totalDealComm = dealTotals.get(svc.deal_id) ?? 0;

    let baseAmount: number;
    if (commVal > 0) {
      if (isRenewal) {
        const origForSvc =
          origSvc > 0 ? origSvc : origDeal > 0 && totalDealComm > 0 ? (origDeal * commVal) / totalDealComm : 0;
        baseAmount = Math.max(0, commVal - origForSvc);
      } else {
        baseAmount = commVal;
      }
    } else {
      baseAmount = isRenewal ? (origDeal > 0 ? Math.max(0, dealVal - origDeal) : 0) : dealVal;
    }
    const basisCommission = baseAmount * rate;
    totalBasisCommission += basisCommission;
    totalBaseAmount += baseAmount;
    rows.push({
      client_name: dealObj?.client_name ?? '',
      deal: svc.service_name || dealObj?.service_type || 'Deal',
      is_renewal: isRenewal ? 'Yes' : 'No',
      base_amount: baseAmount.toFixed(2),
      rate_pct: `${(rate * 100).toFixed(2)}%`,
      basis_commission: basisCommission.toFixed(2),
      group_deal_id: svc.deal_id,
    });
  }

  const dealsWithServices = new Set(services.map((s) => s.deal_id));
  for (const dealId of qDealIds) {
    if (dealsWithServices.has(dealId)) continue;
    const { data: dealRow } = await supabase
      .from('deals')
      .select('client_name, service_type, deal_value, original_deal_value, is_renewal')
      .eq('id', dealId)
      .single();
    if (!dealRow) continue;
    const origDeal = dealRow.original_deal_value ?? 0;
    const dealVal = dealRow.deal_value ?? 0;
    const isRenewal = (dealRow.is_renewal === true || dealRow.is_renewal === 1) && origDeal > 0;
    const baseAmount = isRenewal ? Math.max(0, dealVal - origDeal) : dealVal;
    const basisCommission = baseAmount * defaultRate;
    totalBasisCommission += basisCommission;
    totalBaseAmount += baseAmount;
    rows.push({
      client_name: dealRow.client_name ?? '',
      deal: dealRow.service_type || 'Deal',
      is_renewal: isRenewal ? 'Yes' : 'No',
      base_amount: baseAmount.toFixed(2),
      rate_pct: `${(defaultRate * 100).toFixed(2)}%`,
      basis_commission: basisCommission.toFixed(2),
      group_deal_id: dealId,
    });
  }

  return {
    rows,
    totalBasisCommission: Number(totalBasisCommission.toFixed(2)),
    totalBaseAmount: Number(totalBaseAmount.toFixed(2)),
  };
}

export function basisLabelForType(type: QuarterlyBonusReportType): string {
  switch (type) {
    case 'payable':
      return 'Full quarter — payable date: all commission entries with payable_date in the quarter (includes future payables still inside the quarter-end). 2.5% of attributed revenue per line.';
    case 'cash':
      return 'Through today — payable date: same attribution as full quarter, but only entries whose payable_date is on or before the report run date (within the selected quarter). Not bank cash collection.';
    case 'closed_deals':
      return 'Closed deals — service/deal basis (matches dashboard “Quarterly Commission (Closed Deals)” — not cash)';
    default:
      return '';
  }
}

export function filenameForQuarterlyBonus(quarter: string, type: QuarterlyBonusReportType, ext: string) {
  const day = format(new Date(), 'yyyy-MM-dd');
  return `quarterly-bonus-report-${quarter}-${type}-${day}.${ext}`;
}
