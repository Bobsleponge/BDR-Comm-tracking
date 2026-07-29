import { format } from 'date-fns';
import { calculateTieredCommission, splitRevenueAcrossTiers } from '@/lib/commission/calculator';
import { EXCLUDE_IGNORED_REVENUE_SQL } from '@/lib/commission/entry-source-sync';

type LocalDb = ReturnType<typeof getLocalDB>;

export type AnnualTierRules = {
  threshold: number;
  tier1Rate: number;
  tier2Rate: number;
};

export type AnnualTierCollectionRow = {
  id: string;
  collection_date: string;
  amount_collected: number;
  billing_type?: string | null;
  client_name: string;
  deal: string;
};

export type AnnualTierDetailRow = {
  client_name: string;
  deal: string;
  collection_date: string;
  billing_type: string;
  amount_collected: string;
  cumulative_before: string;
  cumulative_after: string;
  tier_1_revenue: string;
  tier_2_revenue: string;
  tier_1_commission: string;
  tier_2_commission: string;
  tier_commission_total: string;
  group_month: string;
};

export type AnnualTierSummary = {
  year: number;
  threshold: number;
  tier1Rate: number;
  tier2Rate: number;
  revenueCollected: number;
  revenueInTier1: number;
  revenueInTier2: number;
  tier1Commission: number;
  tier2Commission: number;
  totalTierCommission: number;
  tier2ExtraCommission: number;
  remainingToThreshold: number;
  inTier2: boolean;
  projectedRevenueCollected: number;
  projectedRevenueInTier1: number;
  projectedRevenueInTier2: number;
  projectedTier1Commission: number;
  projectedTier2Commission: number;
  projectedTotalTierCommission: number;
  projectedTier2ExtraCommission: number;
};

export type AnnualTierProgress = {
  rules: AnnualTierRules;
  summary: AnnualTierSummary;
  rows: AnnualTierDetailRow[];
};

const DEFAULT_THRESHOLD = 250000;
const DEFAULT_TIER_1_RATE = 0.025;
const DEFAULT_TIER_2_RATE = 0.05;

function tier2ExtraCommissionAmount(revenueInTier2: number, tier1Rate: number, tier2Rate: number): number {
  const extraRate = Math.max(0, tier2Rate - tier1Rate);
  return Number((revenueInTier2 * extraRate).toFixed(2));
}

function summarizeAnnualTierProgress(
  progress: AnnualTierProgress,
  projectedProgress: AnnualTierProgress
): AnnualTierSummary {
  const { rules, summary } = progress;
  const projected = projectedProgress.summary;
  return {
    ...summary,
    tier2ExtraCommission: tier2ExtraCommissionAmount(summary.revenueInTier2, rules.tier1Rate, rules.tier2Rate),
    projectedRevenueCollected: projected.revenueCollected,
    projectedRevenueInTier1: projected.revenueInTier1,
    projectedRevenueInTier2: projected.revenueInTier2,
    projectedTier1Commission: projected.tier1Commission,
    projectedTier2Commission: projected.tier2Commission,
    projectedTotalTierCommission: projected.totalTierCommission,
    projectedTier2ExtraCommission: tier2ExtraCommissionAmount(
      projected.revenueInTier2,
      rules.tier1Rate,
      rules.tier2Rate
    ),
  };
}

export function normalizeAnnualTierRules(rules?: {
  tier_1_threshold?: number | null;
  tier_1_rate?: number | null;
  tier_2_rate?: number | null;
} | null): AnnualTierRules {
  return {
    threshold: Number(rules?.tier_1_threshold ?? DEFAULT_THRESHOLD),
    tier1Rate: Number(rules?.tier_1_rate ?? DEFAULT_TIER_1_RATE),
    tier2Rate: Number(rules?.tier_2_rate ?? DEFAULT_TIER_2_RATE),
  };
}

export function buildAnnualTierProgress(
  rows: AnnualTierCollectionRow[],
  rules: AnnualTierRules,
  year: number
): AnnualTierProgress {
  let cumulativeBefore = 0;
  let revenueInTier1 = 0;
  let revenueInTier2 = 0;
  let tier1Commission = 0;
  let tier2Commission = 0;
  const detailRows: AnnualTierDetailRow[] = [];

  for (const row of rows) {
    const amount = Number(row.amount_collected ?? 0);
    const { tier1Revenue, tier2Revenue } = splitRevenueAcrossTiers(amount, cumulativeBefore, rules.threshold);
    const lineTier1Commission = tier1Revenue * rules.tier1Rate;
    const lineTier2Commission = tier2Revenue * rules.tier2Rate;
    const lineTotalCommission = calculateTieredCommission(
      amount,
      cumulativeBefore,
      rules.threshold,
      rules.tier1Rate,
      rules.tier2Rate
    );
    const cumulativeAfter = cumulativeBefore + amount;

    revenueInTier1 += tier1Revenue;
    revenueInTier2 += tier2Revenue;
    tier1Commission += lineTier1Commission;
    tier2Commission += lineTier2Commission;

    const collectionDate = (row.collection_date || '').split('T')[0];
    const groupMonth = collectionDate.length >= 7 ? collectionDate.substring(0, 7) : '';
    detailRows.push({
      client_name: row.client_name ?? '',
      deal: row.deal || 'Deal',
      collection_date: collectionDate,
      billing_type: row.billing_type || '',
      amount_collected: amount.toFixed(2),
      cumulative_before: cumulativeBefore.toFixed(2),
      cumulative_after: cumulativeAfter.toFixed(2),
      tier_1_revenue: tier1Revenue.toFixed(2),
      tier_2_revenue: tier2Revenue.toFixed(2),
      tier_1_commission: lineTier1Commission.toFixed(2),
      tier_2_commission: lineTier2Commission.toFixed(2),
      tier_commission_total: lineTotalCommission.toFixed(2),
      group_month: groupMonth,
    });

    cumulativeBefore = cumulativeAfter;
  }

  const revenueCollected = Number(cumulativeBefore.toFixed(2));
  const summary: AnnualTierSummary = {
    year,
    threshold: rules.threshold,
    tier1Rate: rules.tier1Rate,
    tier2Rate: rules.tier2Rate,
    revenueCollected,
    revenueInTier1: Number(revenueInTier1.toFixed(2)),
    revenueInTier2: Number(revenueInTier2.toFixed(2)),
    tier1Commission: Number(tier1Commission.toFixed(2)),
    tier2Commission: Number(tier2Commission.toFixed(2)),
    totalTierCommission: Number((tier1Commission + tier2Commission).toFixed(2)),
    tier2ExtraCommission: tier2ExtraCommissionAmount(
      Number(revenueInTier2.toFixed(2)),
      rules.tier1Rate,
      rules.tier2Rate
    ),
    remainingToThreshold: Number(Math.max(0, rules.threshold - revenueCollected).toFixed(2)),
    inTier2: revenueCollected > rules.threshold,
    projectedRevenueCollected: revenueCollected,
    projectedRevenueInTier1: Number(revenueInTier1.toFixed(2)),
    projectedRevenueInTier2: Number(revenueInTier2.toFixed(2)),
    projectedTier1Commission: Number(tier1Commission.toFixed(2)),
    projectedTier2Commission: Number(tier2Commission.toFixed(2)),
    projectedTotalTierCommission: Number((tier1Commission + tier2Commission).toFixed(2)),
    projectedTier2ExtraCommission: tier2ExtraCommissionAmount(
      Number(revenueInTier2.toFixed(2)),
      rules.tier1Rate,
      rules.tier2Rate
    ),
  };

  return { rules, summary, rows: detailRows };
}

export function loadAnnualTierRulesLocal(db: LocalDb): AnnualTierRules {
  const rules = db
    .prepare(
      'SELECT tier_1_threshold, tier_1_rate, tier_2_rate FROM commission_rules ORDER BY updated_at DESC LIMIT 1'
    )
    .get() as { tier_1_threshold: number | null; tier_1_rate: number | null; tier_2_rate: number | null } | undefined;
  return normalizeAnnualTierRules(rules);
}

export async function loadAnnualTierRulesSupabase(supabase: any): Promise<AnnualTierRules> {
  const { data: rules } = await supabase
    .from('commission_rules')
    .select('tier_1_threshold, tier_1_rate, tier_2_rate')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return normalizeAnnualTierRules(rules);
}

export function fetchAnnualTierCollectionRowsLocal(
  db: LocalDb,
  bdrId: string,
  yearStartStr: string,
  yearEndStr: string,
  todayStr: string
): AnnualTierCollectionRow[] {
  return db
    .prepare(
      `
    SELECT
      re.id,
      re.collection_date,
      re.amount_collected,
      re.billing_type,
      d.client_name,
      COALESCE(ds.service_name, d.service_type, 'Deal') as deal
    FROM revenue_events re
    INNER JOIN deals d ON re.deal_id = d.id
    LEFT JOIN deal_services ds ON re.service_id = ds.id
    WHERE re.bdr_id = ?
      AND re.collection_date >= ?
      AND re.collection_date <= ?
      AND re.collection_date <= ?
      AND re.commissionable = 1
      AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
      ${EXCLUDE_IGNORED_REVENUE_SQL}
    ORDER BY re.collection_date ASC, re.id ASC
  `
    )
    .all(bdrId, yearStartStr, yearEndStr, todayStr) as AnnualTierCollectionRow[];
}

export async function fetchAnnualTierCollectionRowsSupabase(
  supabase: any,
  bdrId: string,
  yearStartStr: string,
  yearEndStr: string,
  todayStr: string
): Promise<AnnualTierCollectionRow[]> {
  const { data: rows } = await supabase
    .from('revenue_events')
    .select('id, collection_date, amount_collected, billing_type, deals!inner(client_name, service_type, cancellation_date)')
    .eq('bdr_id', bdrId)
    .gte('collection_date', yearStartStr)
    .lte('collection_date', yearEndStr)
    .lte('collection_date', todayStr)
    .eq('commissionable', true)
    .order('collection_date', { ascending: true })
    .order('id', { ascending: true });

  return (rows || [])
    .filter((row: { collection_date?: string; deals?: unknown }) => {
      const deal = Array.isArray(row.deals) ? row.deals[0] : row.deals;
      const cancellationDate = (deal as { cancellation_date?: string } | null)?.cancellation_date;
      return !cancellationDate || (row.collection_date && row.collection_date < cancellationDate);
    })
    .map((row: any) => {
      const deal = Array.isArray(row.deals) ? row.deals[0] : row.deals;
      return {
        id: row.id,
        collection_date: row.collection_date,
        amount_collected: Number(row.amount_collected ?? 0),
        billing_type: row.billing_type,
        client_name: deal?.client_name ?? '',
        deal: deal?.service_type || 'Deal',
      } satisfies AnnualTierCollectionRow;
    });
}

export function fetchAnnualTierScheduledCollectionRowsLocal(
  db: LocalDb,
  bdrId: string,
  yearStartStr: string,
  yearEndStr: string,
  todayStr: string
): AnnualTierCollectionRow[] {
  return db
    .prepare(
      `
    SELECT
      re.id,
      re.collection_date,
      re.amount_collected,
      re.billing_type,
      d.client_name,
      COALESCE(ds.service_name, d.service_type, 'Deal') as deal
    FROM revenue_events re
    INNER JOIN deals d ON re.deal_id = d.id
    LEFT JOIN deal_services ds ON re.service_id = ds.id
    WHERE re.bdr_id = ?
      AND re.collection_date > ?
      AND re.collection_date >= ?
      AND re.collection_date <= ?
      AND re.commissionable = 1
      AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
      ${EXCLUDE_IGNORED_REVENUE_SQL}
    ORDER BY re.collection_date ASC, re.id ASC
  `
    )
    .all(bdrId, todayStr, yearStartStr, yearEndStr) as AnnualTierCollectionRow[];
}

export async function fetchAnnualTierScheduledCollectionRowsSupabase(
  supabase: any,
  bdrId: string,
  yearStartStr: string,
  yearEndStr: string,
  todayStr: string
): Promise<AnnualTierCollectionRow[]> {
  const { data: rows } = await supabase
    .from('revenue_events')
    .select('id, collection_date, amount_collected, billing_type, deals!inner(client_name, service_type, cancellation_date)')
    .eq('bdr_id', bdrId)
    .gt('collection_date', todayStr)
    .gte('collection_date', yearStartStr)
    .lte('collection_date', yearEndStr)
    .eq('commissionable', true)
    .order('collection_date', { ascending: true })
    .order('id', { ascending: true });

  return (rows || [])
    .filter((row: { collection_date?: string; deals?: unknown }) => {
      const deal = Array.isArray(row.deals) ? row.deals[0] : row.deals;
      const cancellationDate = (deal as { cancellation_date?: string } | null)?.cancellation_date;
      return !cancellationDate || (row.collection_date && row.collection_date < cancellationDate);
    })
    .map((row: any) => {
      const deal = Array.isArray(row.deals) ? row.deals[0] : row.deals;
      return {
        id: row.id,
        collection_date: row.collection_date,
        amount_collected: Number(row.amount_collected ?? 0),
        billing_type: row.billing_type,
        client_name: deal?.client_name ?? '',
        deal: deal?.service_type || 'Deal',
      } satisfies AnnualTierCollectionRow;
    });
}

export function loadAnnualTierProgressLocal(
  db: LocalDb,
  bdrId: string,
  year: number,
  todayStr: string
): AnnualTierProgress {
  const yearStartStr = format(new Date(year, 0, 1), 'yyyy-MM-dd');
  const yearEndStr = format(new Date(year, 11, 31), 'yyyy-MM-dd');
  const rules = loadAnnualTierRulesLocal(db);
  const actualRows = fetchAnnualTierCollectionRowsLocal(db, bdrId, yearStartStr, yearEndStr, todayStr);
  const scheduledRows = fetchAnnualTierScheduledCollectionRowsLocal(db, bdrId, yearStartStr, yearEndStr, todayStr);
  const actualProgress = buildAnnualTierProgress(actualRows, rules, year);
  const projectedProgress = buildAnnualTierProgress([...actualRows, ...scheduledRows], rules, year);
  return {
    rules,
    rows: actualProgress.rows,
    summary: summarizeAnnualTierProgress(actualProgress, projectedProgress),
  };
}

export async function loadAnnualTierProgressSupabase(
  supabase: any,
  bdrId: string,
  year: number,
  todayStr: string
): Promise<AnnualTierProgress> {
  const yearStartStr = format(new Date(year, 0, 1), 'yyyy-MM-dd');
  const yearEndStr = format(new Date(year, 11, 31), 'yyyy-MM-dd');
  const rules = await loadAnnualTierRulesSupabase(supabase);
  const actualRows = await fetchAnnualTierCollectionRowsSupabase(supabase, bdrId, yearStartStr, yearEndStr, todayStr);
  const scheduledRows = await fetchAnnualTierScheduledCollectionRowsSupabase(
    supabase,
    bdrId,
    yearStartStr,
    yearEndStr,
    todayStr
  );
  const actualProgress = buildAnnualTierProgress(actualRows, rules, year);
  const projectedProgress = buildAnnualTierProgress([...actualRows, ...scheduledRows], rules, year);
  return {
    rules,
    rows: actualProgress.rows,
    summary: summarizeAnnualTierProgress(actualProgress, projectedProgress),
  };
}

export function groupAnnualTierRowsByMonth(rows: AnnualTierDetailRow[]): {
  rowsByMonth: Record<string, AnnualTierDetailRow[]>;
  sortedMonths: string[];
} {
  const rowsByMonth: Record<string, AnnualTierDetailRow[]> = {};
  for (const row of rows) {
    const month = row.group_month || 'unknown';
    if (!rowsByMonth[month]) rowsByMonth[month] = [];
    rowsByMonth[month].push(row);
  }
  return {
    rowsByMonth,
    sortedMonths: Object.keys(rowsByMonth).sort(),
  };
}

export function filenameForAnnualTierReport(year: number, fileFormat: 'csv' | 'xlsx'): string {
  return `annual-tier-commission-${year}.${fileFormat}`;
}

export function annualTierBasisLabel(): string {
  return 'Calendar-year commissionable cash collected through today. Revenue up to the annual threshold is modeled at tier 1; revenue above the threshold is modeled at tier 2. The extra 2.5% on tier 2 revenue is modeled as paid at year-end. Quarterly payable-date bonus is separate.';
}
