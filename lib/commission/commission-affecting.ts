const DEAL_COMMISSION_FIELDS = [
  'proposal_date',
  'close_date',
  'first_invoice_date',
  'is_renewal',
  'original_deal_value',
  'cancellation_date',
  'bdr_id',
] as const;

function normalizeDealField(key: string, value: unknown): string | boolean {
  if (key === 'is_renewal') return !!(value === 1 || value === true);
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Whether a deal PATCH body changes fields that affect commission scheduling or amounts.
 */
export function dealUpdateAffectsCommission(
  body: Record<string, unknown>,
  existingDeal: Record<string, unknown>,
  computedFirstInvoiceDate?: string | null
): boolean {
  for (const field of DEAL_COMMISSION_FIELDS) {
    if (body[field] === undefined) continue;
    const next = normalizeDealField(field, body[field]);
    const prev = normalizeDealField(field, existingDeal[field]);
    if (next !== prev) return true;
  }

  if (
    computedFirstInvoiceDate &&
    computedFirstInvoiceDate !== (existingDeal.first_invoice_date as string | undefined)
  ) {
    return true;
  }

  return false;
}
