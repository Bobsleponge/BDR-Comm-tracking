/**
 * Commission for percentage-of-net-sales services.
 * New: claimed × billing_% × base_rate
 * Renewal (option B): claimed × (new billing_% − previous billing_%) × base_rate
 */

export function getEffectiveBillingPercentageForCommission(
  billingPercentage: number | null | undefined,
  options?: {
    isRenewal?: boolean;
    originalBillingPercentage?: number | null;
  }
): number | null {
  if (billingPercentage == null || billingPercentage <= 0) return null;

  if (options?.isRenewal) {
    const previous = Number(options.originalBillingPercentage ?? 0);
    const uplift = billingPercentage - previous;
    return uplift > 0 ? Number(uplift.toFixed(6)) : null;
  }

  return billingPercentage;
}

export function computeNetSalesCommissionAmount(
  amountClaimed: number,
  billingPercentage: number | null | undefined,
  baseRate: number,
  options?: {
    isRenewal?: boolean;
    originalBillingPercentage?: number | null;
  }
): number | null {
  if (amountClaimed <= 0 || baseRate <= 0) return null;

  const effectivePct = getEffectiveBillingPercentageForCommission(billingPercentage, options);
  if (effectivePct == null || effectivePct <= 0) return null;

  return Number((amountClaimed * effectivePct * baseRate).toFixed(2));
}
