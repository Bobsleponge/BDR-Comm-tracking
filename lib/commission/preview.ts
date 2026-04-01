/**
 * Commission Preview - Pure calculation for "what if this deal closed"
 * No DB writes. Used for the standalone commission preview page.
 */

import { addDays, addMonths, startOfMonth, parseISO, format } from 'date-fns';
import { calculateServiceCommissionableValue } from './calculator';

export interface PreviewService {
  service_name: string;
  service_type: string;
  billing_type: 'one_off' | 'mrr' | 'deposit' | 'quarterly' | 'paid_on_completion' | 'percentage_of_net_sales';
  unit_price: number;
  monthly_price: number | null;
  quarterly_price: number | null;
  quantity: number;
  contract_months: number;
  contract_quarters: number;
  commission_rate: number | null;
  billing_percentage?: number | null;
  completion_date: string | null;
  is_renewal?: boolean;
  original_service_value?: number | null;
}

export interface PreviewDeal {
  client_name: string;
  close_date: string;
  first_invoice_date?: string | null;
  is_renewal?: boolean;
  original_deal_value?: number | null;
}

export interface PreviewCommissionEntry {
  service_name: string;
  billing_type: string;
  amount_collected: number;
  collection_date: string;
  accrual_date: string;
  payable_date: string;
  month: string;
  amount: number;
  commission_rate: number;
}

export interface CommissionPreviewResult {
  totalCommission: number;
  entries: PreviewCommissionEntry[];
  byMonth: { month: string; amount: number; entries: PreviewCommissionEntry[] }[];
  summary: {
    totalRevenueCollected: number;
    entryCount: number;
    monthCount: number;
  };
}

function toDate(d: string | Date): Date {
  return typeof d === 'string' ? parseISO(d.split('T')[0]) : d;
}

function toDateStr(d: string | Date): string {
  return typeof d === 'string' ? d.split('T')[0] : format(d, 'yyyy-MM-dd');
}

/**
 * Simulate revenue events and commission entries for a hypothetical deal.
 * Uses same logic as createRevenueEventsForDeal + processRevenueEvent.
 */
export function calculateCommissionPreview(
  deal: PreviewDeal,
  services: PreviewService[],
  baseRate: number = 0.025,
  payoutDelayDays: number = 30
): CommissionPreviewResult {
  const entries: PreviewCommissionEntry[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const closeDate = toDate(deal.close_date);
  const firstInvoiceDate = deal.first_invoice_date
    ? toDate(deal.first_invoice_date)
    : addDays(closeDate, 7);

  const isRenewalDeal = !!deal.is_renewal;
  const dealOriginalValue = Number(deal.original_deal_value ?? 0);
  const totalDealCommissionableValue = services.reduce(
    (sum, s) => sum + getCommissionableValue(s),
    0
  );

  function getCommissionableValue(s: PreviewService): number {
    try {
      return calculateServiceCommissionableValue(
        s.billing_type,
        s.unit_price,
        s.monthly_price,
        s.quarterly_price,
        s.quantity ?? 1,
        s.contract_months ?? 12,
        s.contract_quarters ?? 4
      );
    } catch {
      return 0;
    }
  }

  function addEntry(
    serviceName: string,
    billingType: string,
    amountCollected: number,
    collectionDate: Date,
    commissionRate: number,
    accrualDateOverride?: Date,
    payableDateOverride?: string | null,
    payableDelayDays?: number
  ) {
    const accrualDate = accrualDateOverride
      ? toDateStr(accrualDateOverride)
      : toDateStr(collectionDate);
    const collectionDateStr = toDateStr(collectionDate);

    let payableDate: string;
    if (payableDateOverride) {
      payableDate = payableDateOverride;
    } else {
      const revBilling = billingType.toLowerCase();
      const delay = payableDelayDays ?? (revBilling === 'renewal' ? 0 : payoutDelayDays);
      if (revBilling === 'renewal') {
        payableDate = accrualDate;
      } else if (delay === 7) {
        payableDate = format(addDays(parseISO(accrualDate), 7), 'yyyy-MM-dd');
      } else {
        payableDate = format(addDays(parseISO(accrualDate), delay), 'yyyy-MM-dd');
      }
    }

    const amount = Number((amountCollected * commissionRate).toFixed(2));
    entries.push({
      service_name: serviceName,
      billing_type: billingType,
      amount_collected: amountCollected,
      collection_date: collectionDateStr,
      accrual_date: accrualDate,
      payable_date: payableDate,
      month: accrualDate,
      amount,
      commission_rate: commissionRate,
    });
  }

  for (const service of services) {
    const rate = service.commission_rate ?? baseRate;
    const serviceMarkedRenewal = !!service.is_renewal;
    let serviceAmount = getCommissionableValue(service);

    let originalServiceValue = 0;
    if (serviceMarkedRenewal && service.original_service_value != null && service.original_service_value > 0) {
      originalServiceValue = Number(service.original_service_value);
    } else if (isRenewalDeal && dealOriginalValue > 0) {
      if (services.length === 1) {
        originalServiceValue = dealOriginalValue;
      } else {
        const proportion = totalDealCommissionableValue > 0 ? serviceAmount / totalDealCommissionableValue : 0;
        originalServiceValue = dealOriginalValue * proportion;
      }
    } else if (serviceMarkedRenewal) {
      continue;
    }

    const isRenewalService = serviceMarkedRenewal || (isRenewalDeal && dealOriginalValue > 0);
    let serviceBillingType: string = service.billing_type === 'mrr' ? 'monthly' : service.billing_type === 'quarterly' ? 'quarterly' : 'one_off';

    if (isRenewalService) {
      const uplift = Math.max(0, serviceAmount - originalServiceValue);
      if (uplift <= 0) continue;
      serviceAmount = uplift;
      serviceBillingType = 'renewal';
    }

    if (isRenewalService && serviceBillingType === 'renewal') {
      const renewalPayableDate = addDays(closeDate, 7);
      addEntry(service.service_name, 'renewal', serviceAmount, renewalPayableDate, rate);
    } else if (service.billing_type === 'one_off') {
      addEntry(service.service_name, serviceBillingType, serviceAmount, firstInvoiceDate, rate, undefined, undefined, 0);
    } else if (service.billing_type === 'mrr') {
      const contractMonths = service.contract_months || 12;
      const monthlyAmount = (service.monthly_price || 0) * (service.quantity || 1);
      for (let i = 0; i < contractMonths; i++) {
        // Calendar-month cadence prevents two MRR payments in one month.
        const paymentDate = addMonths(firstInvoiceDate, i);
        addEntry(service.service_name, 'monthly', monthlyAmount, paymentDate, rate, undefined, undefined, 0);
      }
    } else if (service.billing_type === 'quarterly') {
      const contractQuarters = service.contract_quarters || 4;
      const quarterlyAmount = (service.quarterly_price || 0) * (service.quantity || 1);
      for (let i = 0; i < contractQuarters; i++) {
        const paymentDate = addDays(firstInvoiceDate, i * 90);
        addEntry(service.service_name, 'quarterly', quarterlyAmount, paymentDate, rate, undefined, undefined, 0);
      }
    } else if (service.billing_type === 'deposit') {
      const firstHalfAmount = serviceAmount * 0.5;
      // First 50%: accrual = first_invoice_date, payable same day
      addEntry(service.service_name, 'one_off', firstHalfAmount, closeDate, rate, firstInvoiceDate, undefined, 0);
      if (service.completion_date) {
        const secondHalfDate = toDate(service.completion_date);
        const secondHalfAmount = serviceAmount * 0.5;
        // Second 50%: accrual = completion date, payable 7 days after
        addEntry(service.service_name, 'one_off', secondHalfAmount, secondHalfDate, rate, secondHalfDate, undefined, 7);
      }
    } else if (service.billing_type === 'paid_on_completion') {
      const sourceDate = service.completion_date || deal.first_invoice_date;
      if (!sourceDate) continue;
      const completionDate = toDate(sourceDate);
      addEntry(service.service_name, 'one_off', serviceAmount, completionDate, rate, completionDate, undefined, 7);
    } else if (service.billing_type === 'percentage_of_net_sales') {
      // Same time frames as MRR: first payable = close+7, then 30-day cadence
      const contractMonths = service.contract_months || 12;
      for (let i = 0; i < contractMonths; i++) {
        const paymentDate = addDays(firstInvoiceDate, i * payoutDelayDays);
        addEntry(service.service_name, 'percentage_of_net_sales', 0, paymentDate, rate, paymentDate, undefined, 0);
      }
    }
  }

  // Group by month
  const byMonthMap = new Map<string, PreviewCommissionEntry[]>();
  for (const e of entries) {
    const monthKey = e.accrual_date.substring(0, 7);
    if (!byMonthMap.has(monthKey)) byMonthMap.set(monthKey, []);
    byMonthMap.get(monthKey)!.push(e);
  }
  const sortedMonths = Array.from(byMonthMap.keys()).sort();
  const byMonth = sortedMonths.map((month) => {
    const monthEntries = byMonthMap.get(month)!;
    const amount = monthEntries.reduce((s, e) => s + e.amount, 0);
    return { month, amount, entries: monthEntries };
  });

  const totalCommission = entries.reduce((s, e) => s + e.amount, 0);
  const totalRevenueCollected = entries.reduce((s, e) => s + e.amount_collected, 0);

  return {
    totalCommission: Number(totalCommission.toFixed(2)),
    entries,
    byMonth,
    summary: {
      totalRevenueCollected: Number(totalRevenueCollected.toFixed(2)),
      entryCount: entries.length,
      monthCount: byMonth.length,
    },
  };
}
