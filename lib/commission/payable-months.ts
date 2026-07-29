import { getEntryEffectiveMonth } from './entry-month';

export type PayableMonthEntry = {
  payable_date?: string | null;
  accrual_date?: string | null;
  month?: string | null;
};

/** Payable month (YYYY-MM) for UI grouping, export, and filters. */
export function getPayableMonthFromEntry(entry: PayableMonthEntry): string | null {
  return getEntryEffectiveMonth(entry.payable_date, entry.accrual_date, entry.month);
}

/** Sorted unique payable months from commission entries (any horizon — e.g. Aug 2027). */
export function collectPayableMonths(entries: PayableMonthEntry[]): string[] {
  const months = new Set<string>();
  for (const entry of entries) {
    const month = getPayableMonthFromEntry(entry);
    if (month) months.add(month);
  }
  return Array.from(months).sort();
}

export type PayableMonthBucket<T> = {
  month: string;
  totalAmount: number;
  entries: T[];
};

/** Group entries into payable-month buckets (creates months on demand from entry dates). */
export function groupEntriesByPayableMonth<T extends PayableMonthEntry>(
  entries: T[],
  getAmount: (entry: T) => number
): PayableMonthBucket<T>[] {
  const byMonth = new Map<string, PayableMonthBucket<T>>();

  for (const entry of entries) {
    const payableMonth = getPayableMonthFromEntry(entry) ?? 'unknown';
    if (!byMonth.has(payableMonth)) {
      byMonth.set(payableMonth, { month: payableMonth, totalAmount: 0, entries: [] });
    }
    const bucket = byMonth.get(payableMonth)!;
    bucket.totalAmount += getAmount(entry);
    bucket.entries.push(entry);
  }

  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
}
