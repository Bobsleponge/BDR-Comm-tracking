export function normDateStr(d: string | null | undefined): string | null {
  if (d == null || d === '') return null;
  const s = String(d).trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/**
 * Effective commission month used for fingerprint matching and eligibility.
 * Matches logic in eligible/route.ts and approved_commission_fingerprints.
 */
export function getEntryEffectiveMonth(
  payableDate?: string | null,
  accrualDate?: string | null,
  month?: string | null
): string | null {
  const raw = payableDate || accrualDate || (month ? `${month.length === 7 ? month : month.slice(0, 7)}-01` : null);
  if (!raw) return null;
  return raw.slice(0, 7);
}
