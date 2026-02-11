/**
 * Date utility functions for consistent date handling across the application
 * 
 * Standard: All dates are stored as ISO date strings (YYYY-MM-DD) in the database
 * Use date-fns for all date manipulations
 */

import { parseISO, format, addDays, startOfMonth, endOfMonth, startOfQuarter, endOfQuarter } from 'date-fns';

/**
 * Convert a date to ISO date string (YYYY-MM-DD)
 * Handles Date objects, ISO strings, and other date formats
 */
export function toISODateString(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  
  if (typeof date === 'string') {
    // If already in YYYY-MM-DD format, return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return date;
    }
    // Otherwise parse and format
    try {
      return format(parseISO(date), 'yyyy-MM-dd');
    } catch {
      return null;
    }
  }
  
  if (date instanceof Date) {
    return format(date, 'yyyy-MM-dd');
  }
  
  return null;
}

/**
 * Convert a date string to Date object
 * Standardizes parsing of date strings
 */
export function toDate(date: string | Date | null | undefined): Date | null {
  if (!date) return null;
  
  if (date instanceof Date) {
    return date;
  }
  
  if (typeof date === 'string') {
    try {
      return parseISO(date);
    } catch {
      return null;
    }
  }
  
  return null;
}

/**
 * Get today's date as ISO string (YYYY-MM-DD)
 */
export function todayISO(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/**
 * Add days to a date and return ISO string
 */
export function addDaysISO(date: string | Date, days: number): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(addDays(dateObj, days), 'yyyy-MM-dd');
}

/**
 * Get start of month as ISO string
 */
export function startOfMonthISO(date: string | Date): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(startOfMonth(dateObj), 'yyyy-MM-dd');
}

/**
 * Get end of month as ISO string
 */
export function endOfMonthISO(date: string | Date): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(endOfMonth(dateObj), 'yyyy-MM-dd');
}

/**
 * Get start of quarter as ISO string
 */
export function startOfQuarterISO(date: string | Date): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(startOfQuarter(dateObj), 'yyyy-MM-dd');
}

/**
 * Get end of quarter as ISO string
 */
export function endOfQuarterISO(date: string | Date): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(endOfQuarter(dateObj), 'yyyy-MM-dd');
}

