/** Fingerprint for detecting accidental duplicate services on the same deal. */
export function duplicateServiceFingerprint(
  serviceName: string,
  billingType: string,
  commissionableValue: number
): string {
  return `${serviceName.trim().toLowerCase()}|${billingType}|${Number(commissionableValue).toFixed(2)}`;
}

export function findDuplicateService<T extends { service_name: string; billing_type: string; commissionable_value: number }>(
  existing: T[],
  serviceName: string,
  billingType: string,
  commissionableValue: number
): T | undefined {
  const key = duplicateServiceFingerprint(serviceName, billingType, commissionableValue);
  return existing.find(
    (s) => duplicateServiceFingerprint(s.service_name, s.billing_type, Number(s.commissionable_value)) === key
  );
}
