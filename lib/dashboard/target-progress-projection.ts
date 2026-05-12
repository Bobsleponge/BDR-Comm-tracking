import { format } from 'date-fns';
import { getLocalDB } from '@/lib/db/local-db';

type LocalDb = ReturnType<typeof getLocalDB>;

export type TargetProgressProjection = {
  projectedRevenueCollected: number;
  projectedAchievedPercent: number;
};

export function buildTargetProgressProjection(
  actualCollected: number,
  scheduledAdditional: number,
  target: number
): TargetProgressProjection {
  const projectedRevenueCollected = Number((actualCollected + scheduledAdditional).toFixed(2));
  const projectedAchievedPercent =
    target > 0 ? Number(((projectedRevenueCollected / target) * 100).toFixed(2)) : 0;
  return { projectedRevenueCollected, projectedAchievedPercent };
}

export function sumScheduledCashCollectedLocal(
  db: LocalDb,
  bdrId: string,
  todayStr: string,
  periodEndStr: string
): number {
  const row = db
    .prepare(
      `
    SELECT COALESCE(SUM(re.amount_collected), 0) as total
    FROM revenue_events re
    INNER JOIN deals d ON re.deal_id = d.id
    WHERE re.bdr_id = ?
      AND re.collection_date > ?
      AND re.collection_date <= ?
      AND re.commissionable = 1
      AND (d.cancellation_date IS NULL OR re.collection_date < d.cancellation_date)
  `
    )
    .get(bdrId, todayStr, periodEndStr) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

export function sumScheduledCashCollectedSupabase(
  rows: Array<{ amount_collected?: number | null; collection_date?: string; deals?: unknown }>,
  todayStr: string,
  periodEndStr: string
): number {
  return rows.reduce((sum, event) => {
    const collectionDate = (event.collection_date || '').split('T')[0];
    if (!collectionDate || collectionDate <= todayStr || collectionDate > periodEndStr) return sum;
    const deal = Array.isArray(event.deals) ? event.deals[0] : event.deals;
    const cancellationDate = (deal as { cancellation_date?: string } | null)?.cancellation_date;
    if (cancellationDate && collectionDate >= cancellationDate) return sum;
    return sum + Number(event.amount_collected ?? 0);
  }, 0);
}

export function sumPayableAttributedRevenueInQuarter(
  rows: Array<{ payable_date: string; attributed_revenue: string }>,
  quarterKey: string
): number {
  return Number(
    rows
      .filter((row) => quarterKeyFromPayableDate(row.payable_date) === quarterKey)
      .reduce((sum, row) => sum + (Number.parseFloat(row.attributed_revenue || '0') || 0), 0)
      .toFixed(2)
  );
}

function quarterKeyFromPayableDate(payableDate: string): string {
  const date = (payableDate || '').split('T')[0];
  if (date.length < 7) return '';
  return `${date.substring(0, 4)}-Q${Math.ceil(Number(date.substring(5, 7)) / 3)}`;
}

export function yearBounds(year: number) {
  return {
    yearStartStr: format(new Date(year, 0, 1), 'yyyy-MM-dd'),
    yearEndStr: format(new Date(year, 11, 31), 'yyyy-MM-dd'),
  };
}
