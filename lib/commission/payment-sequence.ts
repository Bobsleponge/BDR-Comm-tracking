/**
 * Payment sequence for commission lines (e.g. "3 of 12" for monthly, "2 of 2" for 50/50).
 */

export type PaymentSequence = {
  paymentNumber: number;
  paymentTotal: number;
  label: string;
};

export type ServiceForPaymentCount = {
  billing_type?: string | null;
  contract_months?: number | null;
  contract_quarters?: number | null;
  completion_date?: string | null;
  is_renewal?: boolean | number | null;
};

export type RevenueEventForSequence = {
  id: string;
  collection_date: string;
  payment_stage?: string | null;
};

function isTruthyRenewal(v: boolean | number | null | undefined): boolean {
  return v === true || v === 1;
}

/** Expected number of commissionable payments for a service (deal_services billing_type). */
export function getExpectedPaymentCount(service: ServiceForPaymentCount | null | undefined): number {
  if (!service?.billing_type) return 1;

  const billingType = String(service.billing_type).toLowerCase();

  if (isTruthyRenewal(service.is_renewal)) return 1;

  switch (billingType) {
    case 'deposit':
      return service.completion_date ? 2 : 1;
    case 'mrr':
    case 'percentage_of_net_sales':
      return service.contract_months ?? 12;
    case 'quarterly':
      return service.contract_quarters ?? 4;
    case 'one_off':
    case 'paid_on_completion':
      return 1;
    default:
      return 1;
  }
}

export function formatPaymentSequenceLabel(paymentNumber: number, paymentTotal: number): string {
  const n = Math.max(1, Math.floor(paymentNumber));
  const total = Math.max(1, Math.floor(paymentTotal));
  if (total <= 1) return '1 of 1';
  return `${n} of ${total}`;
}

function compareRevenueEvents(a: RevenueEventForSequence, b: RevenueEventForSequence): number {
  const dateCmp = a.collection_date.localeCompare(b.collection_date);
  if (dateCmp !== 0) return dateCmp;
  // Deposit second half: completion stage after invoice when dates tie
  const stageOrder = (s?: string | null) => {
    if (s === 'invoice') return 0;
    if (s === 'completion') return 1;
    return 2;
  };
  const stageCmp = stageOrder(a.payment_stage) - stageOrder(b.payment_stage);
  if (stageCmp !== 0) return stageCmp;
  return a.id.localeCompare(b.id);
}

/**
 * Map revenue_event id → payment sequence for one service.
 * paymentTotal uses contract length when known; otherwise falls back to event count.
 */
export function buildPaymentSequenceIndexForService(
  service: ServiceForPaymentCount | null | undefined,
  events: RevenueEventForSequence[]
): Map<string, PaymentSequence> {
  const index = new Map<string, PaymentSequence>();
  if (events.length === 0) return index;

  const expected = getExpectedPaymentCount(service);
  const sorted = [...events].sort(compareRevenueEvents);
  const paymentTotal = Math.max(expected, sorted.length);

  sorted.forEach((ev, i) => {
    const paymentNumber = Math.min(i + 1, paymentTotal);
    index.set(ev.id, {
      paymentNumber,
      paymentTotal,
      label: formatPaymentSequenceLabel(paymentNumber, paymentTotal),
    });
  });

  return index;
}

export function paymentSequenceForRevenueEvent(
  service: ServiceForPaymentCount | null | undefined,
  events: RevenueEventForSequence[],
  revenueEventId: string | null | undefined
): PaymentSequence | null {
  if (!revenueEventId) return null;
  const index = buildPaymentSequenceIndexForService(service, events);
  return index.get(revenueEventId) ?? null;
}

/** Single payment when no revenue event / service context. */
export function singlePaymentSequence(): PaymentSequence {
  return { paymentNumber: 1, paymentTotal: 1, label: '1 of 1' };
}
