/** Commission entry was permanently waived by the BDR (not billable, preserved on reprocess). */
export function isEntryIgnored(status: string | null | undefined): boolean {
  return status === 'ignored';
}

/** Excluded from billable totals and report eligibility (cancelled deal vs waived entry). */
export function isEntryExcludedFromBillable(status: string | null | undefined): boolean {
  return status === 'cancelled' || status === 'ignored';
}
