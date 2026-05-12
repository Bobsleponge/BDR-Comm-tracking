import { format } from 'date-fns';
import { getQuarterFromDate, parseQuarter } from '@/lib/commission/calculator';
import {
  getLocalApprovalDisplaySets,
  isEntryApprovedForDisplay,
  normDateStr,
} from '@/lib/commission/entry-approval-display';
import {
  buildQuarterlyPayableProgressFromRows,
  fetchClosedDealsBonusRowsLocal,
  fetchClosedDealsBonusRowsSupabase,
  fetchPayableBonusRowsLocal,
  fetchPayableBonusRowsSupabase,
  type QuarterlyPayableProgressItem,
} from '@/lib/dashboard/quarterly-bonus-export';
import {
  loadAnnualTierProgressLocal,
  loadAnnualTierProgressSupabase,
  type AnnualTierSummary,
} from '@/lib/dashboard/annual-tier-export';
import {
  buildTargetProgressProjection,
  sumPayableAttributedRevenueInQuarter,
  sumScheduledCashCollectedLocal,
  sumScheduledCashCollectedSupabase,
} from '@/lib/dashboard/target-progress-projection';
import { getLocalDB } from '@/lib/db/local-db';

type LocalDb = ReturnType<typeof getLocalDB>;

export type DashboardCommissionBuckets = {
  settled: number;
  pending: number;
  payable: number;
  accrued: number;
  accruedThisMonth: number;
};

export type DashboardProgressSlice = {
  revenueCollected: number;
  newBusinessCollected?: number;
  renewalUpliftCollected?: number;
  achievedPercent: number;
  bonusEligible: boolean;
  target: number;
  projectedRevenueCollected?: number;
  projectedAchievedPercent?: number;
};

export type DashboardAnnualSlice = {
  revenueCollected: number;
  newBusinessCollected: number;
  renewalUpliftCollected: number;
  target: number;
  achievedPercent: number;
  daysElapsed: number;
  daysRemaining: number;
  projectedRevenueCollected?: number;
  projectedAchievedPercent?: number;
};

export type DashboardStatsPayload = {
  closedDeals: number;
  commissionEarned: number;
  commissionAccrued: number;
  commissionAccruedThisMonth: number;
  commissionPayable: number;
  commissionPaid: number;
  commissionPending: number;
  nextMonthPayout: number;
  quarterlyCommissionOnClosedDeals: number;
  quarterlyCommissionBaseAmount: number;
  projectedCommissionByQuarter: Record<string, number>;
  quarterlyProgressByQuarter: Record<string, QuarterlyPayableProgressItem>;
  expectedBonusOnSignedDeals: number;
  expectedBonusOnCashCollected: number;
  projectedQuarterlyBonus: number;
  ytdPayableRevenue: number;
  annualTier: AnnualTierSummary;
  quarterlyProgress: DashboardProgressSlice;
  annualProgress: DashboardAnnualSlice;
  bhagProgress: DashboardAnnualSlice;
};

type CommissionEntryRow = {
  id: string;
  bdr_id: string;
  deal_id: string;
  amount: number | null;
  status: string | null;
  payable_date?: string | null;
  accrual_date?: string | null;
  month?: string | null;
};

type BatchAmountRow = {
  commission_entry_id: string;
  override_amount: number | null;
  override_commission_rate: number | null;
  entry_amount: number | null;
  amount_collected: number | null;
};

const OPEN_COMMISSION_STATUSES = new Set(['payable', 'accrued']);

export function resolveBatchLineAmount(row: {
  override_amount?: number | null;
  override_commission_rate?: number | null;
  entry_amount?: number | null;
  amount_collected?: number | null;
}): number {
  const entryAmount = Number(row.entry_amount ?? 0);
  const amountCollected = Number(row.amount_collected ?? 0);
  let finalAmount = row.override_amount;
  if (finalAmount == null && row.override_commission_rate != null && amountCollected > 0) {
    finalAmount = amountCollected * row.override_commission_rate;
  }
  if (finalAmount == null) finalAmount = entryAmount;
  return Number(finalAmount ?? 0);
}

export function computeCommissionBucketsFromEntries(
  entries: CommissionEntryRow[],
  approvalSets: Parameters<typeof isEntryApprovedForDisplay>[1],
  batchAmountByEntryId: Map<string, number>,
  nextPayoutStr: string,
  currentMonthStr: string,
  nextMonthStr: string
): DashboardCommissionBuckets {
  let settled = 0;
  let pending = 0;
  let payable = 0;
  let accrued = 0;
  let accruedThisMonth = 0;

  for (const entry of entries) {
    const amount = Number(entry.amount ?? 0);
    const status = entry.status ?? '';
    const lineAmount = batchAmountByEntryId.get(entry.id) ?? amount;

    if (isEntryApprovedForDisplay(entry, approvalSets)) {
      settled += lineAmount;
    } else if (OPEN_COMMISSION_STATUSES.has(status)) {
      pending += amount;
    }

    if (status === 'payable') {
      const payableDate = normDateStr(entry.payable_date);
      if (payableDate && payableDate <= nextPayoutStr) {
        payable += amount;
      }
    }

    if (status === 'accrued') {
      accrued += amount;
      const accrualDate = normDateStr(entry.accrual_date);
      if (accrualDate && accrualDate >= currentMonthStr && accrualDate < nextMonthStr) {
        accruedThisMonth += amount;
      }
    }
  }

  return {
    settled: Number(settled.toFixed(2)),
    pending: Number(pending.toFixed(2)),
    payable: Number(payable.toFixed(2)),
    accrued: Number(accrued.toFixed(2)),
    accruedThisMonth: Number(accruedThisMonth.toFixed(2)),
  };
}

function loadBatchAmountsLocal(db: LocalDb, bdrId: string): Map<string, number> {
  const rows = db
    .prepare(
      `
    SELECT
      ce.id AS commission_entry_id,
      cbi.override_amount,
      cbi.override_commission_rate,
      ce.amount AS entry_amount,
      re.amount_collected
    FROM commission_batch_items cbi
    INNER JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    INNER JOIN commission_batches cb ON cbi.batch_id = cb.id
    WHERE cb.bdr_id = ? AND cb.status IN ('approved', 'paid')
  `
    )
    .all(bdrId) as BatchAmountRow[];

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.commission_entry_id, resolveBatchLineAmount(row));
  }
  return map;
}

function loadCommissionEntriesLocal(db: LocalDb, bdrId: string): CommissionEntryRow[] {
  return db
    .prepare(
      `
    SELECT
      ce.id,
      ce.bdr_id,
      ce.deal_id,
      ce.amount,
      ce.status,
      ce.payable_date,
      ce.accrual_date,
      ce.month
    FROM commission_entries ce
    INNER JOIN deals d ON ce.deal_id = d.id
    WHERE ce.bdr_id = ? AND d.cancellation_date IS NULL AND ce.status != 'cancelled'
  `
    )
    .all(bdrId) as CommissionEntryRow[];
}

export function loadCommissionBucketsLocal(
  db: LocalDb,
  bdrId: string,
  nextPayoutStr: string,
  currentMonthStr: string,
  nextMonthStr: string
): DashboardCommissionBuckets {
  const approvalSets = getLocalApprovalDisplaySets(db);
  const batchAmountByEntryId = loadBatchAmountsLocal(db, bdrId);
  const entries = loadCommissionEntriesLocal(db, bdrId);
  return computeCommissionBucketsFromEntries(
    entries,
    approvalSets,
    batchAmountByEntryId,
    nextPayoutStr,
    currentMonthStr,
    nextMonthStr
  );
}

function quarterKeyFromPayableDate(payableDate: string): string {
  return payableDate.substring(0, 4) + '-Q' + Math.ceil(Number(payableDate.substring(5, 7)) / 3);
}

function buildAnnualSlice(
  revenueCollected: number,
  newBusinessCollected: number,
  renewalUpliftCollected: number,
  target: number,
  daysElapsed: number,
  daysRemaining: number
): DashboardAnnualSlice {
  return {
    revenueCollected: Number(revenueCollected.toFixed(2)),
    newBusinessCollected: Number(newBusinessCollected.toFixed(2)),
    renewalUpliftCollected: Number(renewalUpliftCollected.toFixed(2)),
    target,
    achievedPercent: target > 0 ? Number(((revenueCollected / target) * 100).toFixed(2)) : 0,
    daysElapsed,
    daysRemaining,
  };
}

export function loadDashboardStatsLocal(db: LocalDb, bdrId: string, today = new Date()): DashboardStatsPayload {
  const currentQuarter = getQuarterFromDate(today);
  const todayStr = format(today, 'yyyy-MM-dd');
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const currentMonthStr = format(currentMonthStart, 'yyyy-MM-dd');
  const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextMonthStr = format(nextMonthStart, 'yyyy-MM-dd');
  const nextPayoutDate = new Date(today);
  nextPayoutDate.setDate(nextPayoutDate.getDate() + 30);
  const nextPayoutStr = format(nextPayoutDate, 'yyyy-MM-dd');
  const { start: quarterStart, end: quarterEnd } = parseQuarter(currentQuarter);
  const quarterStartStr = format(quarterStart, 'yyyy-MM-dd');
  const quarterEndStr = format(quarterEnd, 'yyyy-MM-dd');
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const yearEnd = new Date(today.getFullYear(), 11, 31);
  const yearStartStr = format(yearStart, 'yyyy-MM-dd');
  const yearEndStr = format(yearEnd, 'yyyy-MM-dd');
  const year = today.getFullYear();
  const yearQuarterStart = format(new Date(year, 0, 1), 'yyyy-MM-dd');
  const yearQuarterEnd = format(new Date(year, 11, 31), 'yyyy-MM-dd');

  const closedDeals =
    (
      db.prepare('SELECT COUNT(*) as count FROM deals WHERE bdr_id = ? AND status = ?').get(bdrId, 'closed-won') as
        | { count: number }
        | undefined
    )?.count ?? 0;

  const quarterlySignedDealsValue = Number(
    (
      db
        .prepare(
          `
      SELECT COALESCE(SUM(deal_value), 0) as total
      FROM deals
      WHERE bdr_id = ? AND status = 'closed-won'
      AND COALESCE(close_date, proposal_date) >= ? AND COALESCE(close_date, proposal_date) <= ?
    `
        )
        .get(bdrId, quarterStartStr, quarterEndStr) as { total: number } | undefined
    )?.total ?? 0
  );

  const commissionRules = db
    .prepare('SELECT quarterly_target FROM commission_rules ORDER BY updated_at DESC LIMIT 1')
    .get() as { quarterly_target: number } | undefined;
  const defaultQuarterlyTarget = commissionRules?.quarterly_target || 75000;

  const quarterlyPerf = db
    .prepare(
      `
    SELECT qp.revenue_collected, qp.achieved_percent, qp.bonus_eligible, qt.target_revenue
    FROM quarterly_performance qp
    LEFT JOIN quarterly_targets qt ON qp.quarter = qt.quarter AND qp.bdr_id = qt.bdr_id
    WHERE qp.bdr_id = ? AND qp.quarter = ?
  `
    )
    .get(bdrId, currentQuarter) as { target_revenue: number | null } | undefined;
  const quarterlyTarget = quarterlyPerf?.target_revenue ?? defaultQuarterlyTarget;

  const buckets = loadCommissionBucketsLocal(db, bdrId, nextPayoutStr, currentMonthStr, nextMonthStr);
  const closedDealsBonus = fetchClosedDealsBonusRowsLocal(db, bdrId, quarterStartStr, quarterEndStr);
  const payableRowsForYear = fetchPayableBonusRowsLocal(db, bdrId, yearQuarterStart, yearQuarterEnd).rows;
  const { projectedBonusByQuarter: projectedCommissionByQuarter, progressByQuarter } = buildQuarterlyPayableProgressFromRows(
    payableRowsForYear,
    year,
    todayStr,
    defaultQuarterlyTarget
  );

  const ytdPayableRevenue = Number(
    payableRowsForYear
      .filter((row) => row.payable_date <= todayStr)
      .reduce((sum, row) => sum + (Number.parseFloat(row.attributed_revenue || '0') || 0), 0)
      .toFixed(2)
  );

  const currentQuarterProgress = progressByQuarter[currentQuarter] ?? {
    revenue: 0,
    commission: 0,
    bonus: 0,
    target: defaultQuarterlyTarget,
    achievedPercent: 0,
  };
  const quarterlyRevenueCollected = Number(currentQuarterProgress.revenue || 0);

  let quarterlyNewBusinessCollected = 0;
  let quarterlyRenewalUpliftCollected = 0;
  for (const row of payableRowsForYear) {
    if (row.payable_date > todayStr) continue;
    if (quarterKeyFromPayableDate(row.payable_date) !== currentQuarter) continue;
    const revenue = Number.parseFloat(row.attributed_revenue || '0') || 0;
    if (row.billing_type === 'renewal') quarterlyRenewalUpliftCollected += revenue;
    else quarterlyNewBusinessCollected += revenue;
  }

  const annualRevenue = Number(
    (
      db
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
        .get(bdrId, yearStartStr, yearEndStr, todayStr) as { total: number } | undefined
    )?.total ?? 0
  );
  const annualNewBusiness = Number(
    (
      db
        .prepare(
          `
      SELECT COALESCE(SUM(re.amount_collected), 0) as total
      FROM revenue_events re
      INNER JOIN deals d ON re.deal_id = d.id
      WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ?
      AND re.commissionable = 1 AND re.billing_type != 'renewal'
      AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
    `
        )
        .get(bdrId, yearStartStr, yearEndStr, todayStr) as { total: number } | undefined
    )?.total ?? 0
  );
  const annualRenewalUplift = Number(
    (
      db
        .prepare(
          `
      SELECT COALESCE(SUM(re.amount_collected), 0) as total
      FROM revenue_events re
      INNER JOIN deals d ON re.deal_id = d.id
      WHERE re.bdr_id = ? AND re.collection_date >= ? AND re.collection_date <= ? AND re.collection_date <= ?
      AND re.commissionable = 1 AND re.billing_type = 'renewal'
      AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
    `
        )
        .get(bdrId, yearStartStr, yearEndStr, todayStr) as { total: number } | undefined
    )?.total ?? 0
  );

  const yearStartTime = yearStart.getTime();
  const yearEndTime = yearEnd.getTime();
  const todayTime = today.getTime();
  const daysElapsed = Math.floor((todayTime - yearStartTime) / (1000 * 60 * 60 * 24)) + 1;
  const daysInYear = Math.floor((yearEndTime - yearStartTime) / (1000 * 60 * 60 * 24)) + 1;
  const daysRemaining = daysInYear - daysElapsed;

  const bhagTarget = 800000;
  const annualTier = loadAnnualTierProgressLocal(db, bdrId, year, todayStr).summary;
  const annualGoalTarget = annualTier.threshold;
  const quarterlyFullQuarterRevenue = sumPayableAttributedRevenueInQuarter(
    payableRowsForYear.map((row) => ({
      payable_date: row.payable_date,
      attributed_revenue: row.attributed_revenue,
    })),
    currentQuarter
  );
  const quarterlyProjection = buildTargetProgressProjection(
    quarterlyRevenueCollected,
    Math.max(0, quarterlyFullQuarterRevenue - quarterlyRevenueCollected),
    quarterlyTarget
  );
  const scheduledAnnual = sumScheduledCashCollectedLocal(db, bdrId, todayStr, yearEndStr);
  const annualProjection = buildTargetProgressProjection(annualRevenue, scheduledAnnual, annualGoalTarget);
  const bhagProjection = buildTargetProgressProjection(annualRevenue, scheduledAnnual, bhagTarget);

  return {
    closedDeals,
    commissionEarned: buckets.settled,
    commissionAccrued: buckets.accrued,
    commissionAccruedThisMonth: buckets.accruedThisMonth,
    commissionPayable: buckets.payable,
    commissionPaid: buckets.settled,
    commissionPending: buckets.pending,
    nextMonthPayout: buckets.payable,
    quarterlyCommissionOnClosedDeals: Number(closedDealsBonus.totalBasisCommission.toFixed(2)),
    quarterlyCommissionBaseAmount: Number(closedDealsBonus.totalBaseAmount.toFixed(2)),
    projectedCommissionByQuarter,
    quarterlyProgressByQuarter: progressByQuarter,
    expectedBonusOnSignedDeals: Number((quarterlySignedDealsValue * 0.025).toFixed(2)),
    expectedBonusOnCashCollected: Number((quarterlyRevenueCollected * 0.025).toFixed(2)),
    projectedQuarterlyBonus: Number((projectedCommissionByQuarter[currentQuarter] ?? 0).toFixed(2)),
    ytdPayableRevenue,
    annualTier,
    quarterlyProgress: {
      revenueCollected: quarterlyRevenueCollected,
      newBusinessCollected: Number(quarterlyNewBusinessCollected.toFixed(2)),
      renewalUpliftCollected: Number(quarterlyRenewalUpliftCollected.toFixed(2)),
      achievedPercent: Number(currentQuarterProgress.achievedPercent.toFixed(2)),
      bonusEligible: quarterlyRevenueCollected >= quarterlyTarget,
      target: quarterlyTarget,
      projectedRevenueCollected: quarterlyProjection.projectedRevenueCollected,
      projectedAchievedPercent: quarterlyProjection.projectedAchievedPercent,
    },
    annualProgress: {
      ...buildAnnualSlice(annualRevenue, annualNewBusiness, annualRenewalUplift, annualGoalTarget, daysElapsed, daysRemaining),
      ...annualProjection,
    },
    bhagProgress: {
      ...buildAnnualSlice(annualRevenue, annualNewBusiness, annualRenewalUplift, bhagTarget, daysElapsed, daysRemaining),
      ...bhagProjection,
    },
  };
}

async function loadSupabaseApprovalSets(supabase: any) {
  const { data: approvedBatches } = await supabase
    .from('commission_batches')
    .select('id')
    .in('status', ['approved', 'paid']);
  const approvedBatchIds = (approvedBatches || []).map((batch: { id: string }) => batch.id);

  const approvedEntryIds = new Set<string>();
  const batchAmountByEntryId = new Map<string, number>();
  if (approvedBatchIds.length > 0) {
    const { data: batchItems } = await supabase
      .from('commission_batch_items')
      .select(
        `
        commission_entry_id,
        override_amount,
        override_commission_rate,
        commission_entries(amount, revenue_events(amount_collected))
      `
      )
      .in('batch_id', approvedBatchIds);

    for (const item of batchItems || []) {
      const entryId = item.commission_entry_id as string;
      approvedEntryIds.add(entryId);
      const entry = Array.isArray(item.commission_entries) ? item.commission_entries[0] : item.commission_entries;
      const revenue = Array.isArray(entry?.revenue_events) ? entry.revenue_events[0] : entry?.revenue_events;
      batchAmountByEntryId.set(
        entryId,
        resolveBatchLineAmount({
          override_amount: item.override_amount,
          override_commission_rate: item.override_commission_rate,
          entry_amount: entry?.amount,
          amount_collected: revenue?.amount_collected,
        })
      );
    }
  }

  const { data: fingerprints } = await supabase
    .from('approved_commission_fingerprints')
    .select('bdr_id, deal_id, effective_date');

  const fpSet = new Set(
    (fingerprints || []).map(
      (fingerprint: { bdr_id: string; deal_id: string; effective_date: string }) =>
        `${fingerprint.bdr_id}|${fingerprint.deal_id}|${normDateStr(fingerprint.effective_date) || fingerprint.effective_date}`
    )
  );
  const fpMonthSet = new Set(
    (fingerprints || [])
      .map((fingerprint: { bdr_id: string; deal_id: string; effective_date: string }) => {
        const normalized = normDateStr(fingerprint.effective_date);
        const month = normalized && normalized.length >= 7 ? normalized.slice(0, 7) : '';
        return month ? `${fingerprint.bdr_id}|${fingerprint.deal_id}|${month}` : '';
      })
      .filter(Boolean)
  );

  return { approvedEntryIds, fpSet, fpMonthSet, batchAmountByEntryId };
}

function isEntryApprovedForDisplaySupabase(
  entry: CommissionEntryRow,
  sets: {
    approvedEntryIds: Set<string>;
    fpSet: Set<string>;
    fpMonthSet: Set<string>;
  }
): boolean {
  if (entry.status === 'paid') return true;
  if (sets.approvedEntryIds.has(entry.id)) return true;

  const effectiveRaw = entry.payable_date || entry.accrual_date || (entry.month ? `${entry.month}-01` : null);
  const effective = normDateStr(effectiveRaw) || effectiveRaw;
  if (!effective || typeof effective !== 'string') return false;
  const monthKey = effective.length >= 7 ? `${entry.bdr_id}|${entry.deal_id}|${effective.slice(0, 7)}` : '';
  return (
    sets.fpSet.has(`${entry.bdr_id}|${entry.deal_id}|${effective}`) ||
    (!!monthKey && sets.fpMonthSet.has(monthKey))
  );
}

export async function loadCommissionBucketsSupabase(
  supabase: any,
  bdrId: string,
  nextPayoutStr: string,
  currentMonthStr: string,
  nextMonthStr: string
): Promise<DashboardCommissionBuckets> {
  const sets = await loadSupabaseApprovalSets(supabase);
  const { data: entries } = await supabase
    .from('commission_entries')
    .select('id, bdr_id, deal_id, amount, status, payable_date, accrual_date, month, deals!inner(cancellation_date)')
    .eq('bdr_id', bdrId)
    .is('deals.cancellation_date', null)
    .neq('status', 'cancelled');

  const normalizedEntries = (entries || []).map((entry: CommissionEntryRow) => ({
    id: entry.id,
    bdr_id: entry.bdr_id,
    deal_id: entry.deal_id,
    amount: entry.amount,
    status: entry.status,
    payable_date: entry.payable_date,
    accrual_date: entry.accrual_date,
    month: entry.month,
  }));

  let settled = 0;
  let pending = 0;
  let payable = 0;
  let accrued = 0;
  let accruedThisMonth = 0;

  for (const entry of normalizedEntries) {
    const amount = Number(entry.amount ?? 0);
    const status = entry.status ?? '';
    const lineAmount = sets.batchAmountByEntryId.get(entry.id) ?? amount;

    if (isEntryApprovedForDisplaySupabase(entry, sets)) {
      settled += lineAmount;
    } else if (OPEN_COMMISSION_STATUSES.has(status)) {
      pending += amount;
    }

    if (status === 'payable') {
      const payableDate = normDateStr(entry.payable_date);
      if (payableDate && payableDate <= nextPayoutStr) {
        payable += amount;
      }
    }

    if (status === 'accrued') {
      accrued += amount;
      const accrualDate = normDateStr(entry.accrual_date);
      if (accrualDate && accrualDate >= currentMonthStr && accrualDate < nextMonthStr) {
        accruedThisMonth += amount;
      }
    }
  }

  return {
    settled: Number(settled.toFixed(2)),
    pending: Number(pending.toFixed(2)),
    payable: Number(payable.toFixed(2)),
    accrued: Number(accrued.toFixed(2)),
    accruedThisMonth: Number(accruedThisMonth.toFixed(2)),
  };
}

export async function loadDashboardStatsSupabase(supabase: any, bdrId: string, today = new Date()): Promise<DashboardStatsPayload> {
  const currentQuarter = getQuarterFromDate(today);
  const todayStr = format(today, 'yyyy-MM-dd');
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const currentMonthStr = format(currentMonthStart, 'yyyy-MM-dd');
  const nextMonthStart = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextMonthStr = format(nextMonthStart, 'yyyy-MM-dd');
  const nextPayoutDate = new Date(today);
  nextPayoutDate.setDate(nextPayoutDate.getDate() + 30);
  const nextPayoutStr = format(nextPayoutDate, 'yyyy-MM-dd');
  const { start: quarterStart, end: quarterEnd } = parseQuarter(currentQuarter);
  const quarterStartStr = format(quarterStart, 'yyyy-MM-dd');
  const quarterEndStr = format(quarterEnd, 'yyyy-MM-dd');
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const yearEnd = new Date(today.getFullYear(), 11, 31);
  const yearStartStr = format(yearStart, 'yyyy-MM-dd');
  const yearEndStr = format(yearEnd, 'yyyy-MM-dd');
  const year = today.getFullYear();
  const yearQuarterStart = format(new Date(year, 0, 1), 'yyyy-MM-dd');
  const yearQuarterEnd = format(new Date(year, 11, 31), 'yyyy-MM-dd');

  const { count: closedDealsCount } = await supabase
    .from('deals')
    .select('*', { count: 'exact', head: true })
    .eq('bdr_id', bdrId)
    .eq('status', 'closed-won');

  const { data: commissionRules } = await supabase
    .from('commission_rules')
    .select('quarterly_target')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const defaultQuarterlyTarget = commissionRules?.quarterly_target || 75000;

  const { data: quarterlyPerf } = await supabase
    .from('quarterly_performance')
    .select('revenue_collected, achieved_percent, bonus_eligible, quarterly_targets(target_revenue)')
    .eq('bdr_id', bdrId)
    .eq('quarter', currentQuarter)
    .maybeSingle();
  const quarterlyTarget = quarterlyPerf?.quarterly_targets?.target_revenue ?? defaultQuarterlyTarget;

  const buckets = await loadCommissionBucketsSupabase(supabase, bdrId, nextPayoutStr, currentMonthStr, nextMonthStr);
  const closedDealsBonus = await fetchClosedDealsBonusRowsSupabase(supabase, bdrId, quarterStartStr, quarterEndStr);
  const payableRowsForYear = (await fetchPayableBonusRowsSupabase(supabase, bdrId, yearQuarterStart, yearQuarterEnd)).rows;
  const { projectedBonusByQuarter: projectedCommissionByQuarter, progressByQuarter } = buildQuarterlyPayableProgressFromRows(
    payableRowsForYear,
    year,
    todayStr,
    defaultQuarterlyTarget
  );

  const ytdPayableRevenue = Number(
    payableRowsForYear
      .filter((row) => row.payable_date <= todayStr)
      .reduce((sum, row) => sum + (Number.parseFloat(row.attributed_revenue || '0') || 0), 0)
      .toFixed(2)
  );

  const currentQuarterProgress = progressByQuarter[currentQuarter] ?? {
    revenue: 0,
    commission: 0,
    bonus: 0,
    target: defaultQuarterlyTarget,
    achievedPercent: 0,
  };
  const quarterlyRevenueCollected = Number(currentQuarterProgress.revenue || 0);

  let quarterlyNewBusinessCollected = 0;
  let quarterlyRenewalUpliftCollected = 0;
  for (const row of payableRowsForYear) {
    if (row.payable_date > todayStr) continue;
    if (quarterKeyFromPayableDate(row.payable_date) !== currentQuarter) continue;
    const revenue = Number.parseFloat(row.attributed_revenue || '0') || 0;
    if (row.billing_type === 'renewal') quarterlyRenewalUpliftCollected += revenue;
    else quarterlyNewBusinessCollected += revenue;
  }

  const { data: annualRows } = await supabase
    .from('revenue_events')
    .select('amount_collected, collection_date, billing_type, deals!inner(cancellation_date)')
    .eq('bdr_id', bdrId)
    .gte('collection_date', yearStartStr)
    .lte('collection_date', yearEndStr)
    .lte('collection_date', todayStr)
    .eq('commissionable', true);

  const annualFiltered = (annualRows || []).filter((event: { collection_date?: string; deals?: unknown }) => {
    const deal = Array.isArray(event.deals) ? event.deals[0] : event.deals;
    const cancellationDate = (deal as { cancellation_date?: string } | null)?.cancellation_date;
    return !cancellationDate || (event.collection_date && event.collection_date < cancellationDate);
  });

  const annualRevenue = annualFiltered.reduce(
    (sum: number, event: { amount_collected?: number }) => sum + Number(event.amount_collected || 0),
    0
  );
  const annualNewBusiness = annualFiltered
    .filter((event: { billing_type?: string }) => event.billing_type !== 'renewal')
    .reduce((sum: number, event: { amount_collected?: number }) => sum + Number(event.amount_collected || 0), 0);
  const annualRenewalUplift = annualFiltered
    .filter((event: { billing_type?: string }) => event.billing_type === 'renewal')
    .reduce((sum: number, event: { amount_collected?: number }) => sum + Number(event.amount_collected || 0), 0);

  const { data: signedDeals } = await supabase
    .from('deals')
    .select('deal_value, close_date, proposal_date')
    .eq('bdr_id', bdrId)
    .eq('status', 'closed-won');
  const quarterlySignedDealsValue = (signedDeals || []).reduce(
    (sum: number, deal: { deal_value: number; close_date: string | null; proposal_date: string }) => {
      const signDate = deal.close_date || deal.proposal_date;
      if (!signDate) return sum;
      const dateStr = signDate.split('T')[0];
      if (dateStr >= quarterStartStr && dateStr <= quarterEndStr) return sum + Number(deal.deal_value || 0);
      return sum;
    },
    0
  );

  const yearStartTime = yearStart.getTime();
  const yearEndTime = yearEnd.getTime();
  const todayTime = today.getTime();
  const daysElapsed = Math.floor((todayTime - yearStartTime) / (1000 * 60 * 60 * 24)) + 1;
  const daysInYear = Math.floor((yearEndTime - yearStartTime) / (1000 * 60 * 60 * 24)) + 1;
  const daysRemaining = daysInYear - daysElapsed;

  const bhagTarget = 800000;
  const annualTier = (await loadAnnualTierProgressSupabase(supabase, bdrId, year, todayStr)).summary;
  const annualGoalTarget = annualTier.threshold;
  const quarterlyFullQuarterRevenue = sumPayableAttributedRevenueInQuarter(
    payableRowsForYear.map((row) => ({
      payable_date: row.payable_date,
      attributed_revenue: row.attributed_revenue,
    })),
    currentQuarter
  );
  const quarterlyProjection = buildTargetProgressProjection(
    quarterlyRevenueCollected,
    Math.max(0, quarterlyFullQuarterRevenue - quarterlyRevenueCollected),
    quarterlyTarget
  );

  const { data: scheduledAnnualRows } = await supabase
    .from('revenue_events')
    .select('amount_collected, collection_date, deals!inner(cancellation_date)')
    .eq('bdr_id', bdrId)
    .gt('collection_date', todayStr)
    .lte('collection_date', yearEndStr)
    .eq('commissionable', true);
  const scheduledAnnual = sumScheduledCashCollectedSupabase(scheduledAnnualRows || [], todayStr, yearEndStr);
  const annualProjection = buildTargetProgressProjection(annualRevenue, scheduledAnnual, annualGoalTarget);
  const bhagProjection = buildTargetProgressProjection(annualRevenue, scheduledAnnual, bhagTarget);

  return {
    closedDeals: closedDealsCount ?? 0,
    commissionEarned: buckets.settled,
    commissionAccrued: buckets.accrued,
    commissionAccruedThisMonth: buckets.accruedThisMonth,
    commissionPayable: buckets.payable,
    commissionPaid: buckets.settled,
    commissionPending: buckets.pending,
    nextMonthPayout: buckets.payable,
    quarterlyCommissionOnClosedDeals: Number(closedDealsBonus.totalBasisCommission.toFixed(2)),
    quarterlyCommissionBaseAmount: Number(closedDealsBonus.totalBaseAmount.toFixed(2)),
    projectedCommissionByQuarter,
    quarterlyProgressByQuarter: progressByQuarter,
    expectedBonusOnSignedDeals: Number((quarterlySignedDealsValue * 0.025).toFixed(2)),
    expectedBonusOnCashCollected: Number((quarterlyRevenueCollected * 0.025).toFixed(2)),
    projectedQuarterlyBonus: Number((projectedCommissionByQuarter[currentQuarter] ?? 0).toFixed(2)),
    ytdPayableRevenue,
    annualTier,
    quarterlyProgress: {
      revenueCollected: Number(quarterlyRevenueCollected.toFixed(2)),
      newBusinessCollected: Number(quarterlyNewBusinessCollected.toFixed(2)),
      renewalUpliftCollected: Number(quarterlyRenewalUpliftCollected.toFixed(2)),
      achievedPercent: Number(currentQuarterProgress.achievedPercent.toFixed(2)),
      bonusEligible: quarterlyRevenueCollected >= quarterlyTarget,
      target: quarterlyTarget,
      projectedRevenueCollected: quarterlyProjection.projectedRevenueCollected,
      projectedAchievedPercent: quarterlyProjection.projectedAchievedPercent,
    },
    annualProgress: {
      ...buildAnnualSlice(annualRevenue, annualNewBusiness, annualRenewalUplift, annualGoalTarget, daysElapsed, daysRemaining),
      ...annualProjection,
    },
    bhagProgress: {
      ...buildAnnualSlice(annualRevenue, annualNewBusiness, annualRenewalUplift, bhagTarget, daysElapsed, daysRemaining),
      ...bhagProjection,
    },
  };
}

export function loadDashboardStatsForBdr(
  bdrId: string,
  options?: { today?: Date; supabase?: any }
): DashboardStatsPayload | Promise<DashboardStatsPayload> {
  const today = options?.today ?? new Date();
  if (options?.supabase) {
    return loadDashboardStatsSupabase(options.supabase, bdrId, today);
  }
  return loadDashboardStatsLocal(getLocalDB(), bdrId, today);
}
