import { isPast, startOfMonth } from 'date-fns';

/**
 * Check if a commission entry is overdue
 * An entry is overdue if:
 * - Status is 'pending'
 * - The month has passed
 */
export function isOverdue(entry: { month: string; status: string }): boolean {
  if (entry.status !== 'pending') {
    return false;
  }

  const entryDate = new Date(entry.month);
  const entryMonthStart = startOfMonth(entryDate);
  const today = new Date();

  return isPast(entryMonthStart) && today > entryMonthStart;
}

/**
 * Get overdue entries from a list
 */
export function getOverdueEntries<T extends { month: string; status: string }>(
  entries: T[]
): T[] {
  return entries.filter(isOverdue);
}





