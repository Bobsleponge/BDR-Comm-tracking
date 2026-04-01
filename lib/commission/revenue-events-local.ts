/**
 * Local-DB-only revenue/commission logic for use in scripts.
 * Does NOT import server-only - safe for tsx/node execution.
 */

import { getLocalDB } from '@/lib/db/local-db';
import { generateUUID } from '@/lib/utils/uuid';
import { parseISO, addDays, addMonths, startOfMonth, format } from 'date-fns';

export async function createRevenueEvent(
  dealId: string,
  serviceId: string | null,
  bdrId: string,
  amountCollected: number,
  collectionDate: Date,
  billingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal',
  paymentStage: 'invoice' | 'completion' | 'renewal' | 'scheduled',
  commissionable: boolean = true
): Promise<string> {
  const db = getLocalDB();
  const eventId = generateUUID();
  const collectionDateStr = format(collectionDate, 'yyyy-MM-dd');
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO revenue_events (
      id, deal_id, service_id, bdr_id, amount_collected,
      collection_date, billing_type, payment_stage, commissionable,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId, dealId, serviceId, bdrId, amountCollected,
    collectionDateStr, billingType, paymentStage, commissionable ? 1 : 0,
    now, now
  );

  return eventId;
}

export async function processRevenueEvent(eventId: string): Promise<string | null> {
  const db = getLocalDB();
  const event = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(eventId) as any;
  if (!event) throw new Error('Revenue event not found');
  if (!event.commissionable) return null;

  const existing = db.prepare('SELECT id FROM commission_entries WHERE revenue_event_id = ?').get(eventId) as { id: string } | undefined;
  if (existing) return existing.id;

  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(event.deal_id) as any;
  if (!deal) throw new Error('Deal not found');

  const service = event.service_id
    ? db.prepare('SELECT * FROM deal_services WHERE id = ?').get(event.service_id) as any
    : null;

  const rules = db.prepare('SELECT * FROM commission_rules LIMIT 1').get() as any;
  const commissionRate = rules?.base_rate || 0.025; // 2.5% for all including renewals (uplift)
  const commissionAmount = event.amount_collected * commissionRate;
  const payoutDelayDays = rules?.payout_delay_days || 30;
  const isDeposit = service?.billing_type === 'deposit';

  let accrualDate: string;
  let isDepositSecondHalf = false;
  // For paid_on_completion: accrual = completion date (collection_date), normalized to YYYY-MM-DD
  if (service?.billing_type === 'paid_on_completion') {
    accrualDate = typeof event.collection_date === 'string'
      ? event.collection_date.split('T')[0]
      : format(new Date(event.collection_date), 'yyyy-MM-dd');
  } else if (isDeposit && deal.first_invoice_date && service?.completion_date) {
    const completionDateStr = typeof service.completion_date === 'string'
      ? service.completion_date.split('T')[0]
      : format(new Date(service.completion_date), 'yyyy-MM-dd');
    if (event.collection_date === completionDateStr) {
      accrualDate = event.collection_date;
      isDepositSecondHalf = true;
    } else {
      accrualDate = typeof deal.first_invoice_date === 'string'
        ? deal.first_invoice_date.split('T')[0]
        : format(new Date(deal.first_invoice_date), 'yyyy-MM-dd');
    }
  } else if (isDeposit && deal.first_invoice_date) {
    accrualDate = typeof deal.first_invoice_date === 'string'
      ? deal.first_invoice_date.split('T')[0]
      : format(new Date(deal.first_invoice_date), 'yyyy-MM-dd');
  } else {
    accrualDate = event.collection_date;
  }

  const firstInvoiceDateStr = deal.first_invoice_date
    ? (typeof deal.first_invoice_date === 'string' ? deal.first_invoice_date.split('T')[0] : format(new Date(deal.first_invoice_date), 'yyyy-MM-dd'))
    : null;
  const isFirstPayment = firstInvoiceDateStr && accrualDate === firstInvoiceDateStr;

  let payableDate: string;
  const revBilling = (event.billing_type || service?.billing_type || '').toLowerCase();
  // Paid on completion: commission payable 7 days after completion date (funds processing time)
  // Deposit second 50%: same 7-day delay (work billed by month-end, funds need time to process)
  if (service?.billing_type === 'paid_on_completion') {
    payableDate = format(addDays(parseISO(accrualDate), 7), 'yyyy-MM-dd');
  } else if (isDepositSecondHalf) {
    payableDate = format(addDays(parseISO(accrualDate), 7), 'yyyy-MM-dd');
  } else if (revBilling === 'renewal') {
    payableDate = accrualDate;
  } else if (isFirstPayment) {
    payableDate = accrualDate;
  } else {
    if ((revBilling === 'monthly' || revBilling === 'mrr') && firstInvoiceDateStr) {
      const sameDealService = db.prepare(`
        SELECT id, collection_date FROM revenue_events
        WHERE deal_id = ? AND service_id = ? AND commissionable = 1
        ORDER BY collection_date
      `).all(event.deal_id, event.service_id || '') as Array<{ id: string; collection_date: string }>;
      const paymentIndex = sameDealService.findIndex((r: any) => r.id === eventId);
      const index = paymentIndex >= 0 ? paymentIndex : 0;
      const firstInvoiceObj = parseISO(firstInvoiceDateStr);
      payableDate = format(addMonths(firstInvoiceObj, index), 'yyyy-MM-dd');
    } else if ((revBilling === 'quarterly') && firstInvoiceDateStr) {
      const sameDealService = db.prepare(`
        SELECT id, collection_date FROM revenue_events
        WHERE deal_id = ? AND service_id = ? AND commissionable = 1
        ORDER BY collection_date
      `).all(event.deal_id, event.service_id || '') as Array<{ id: string; collection_date: string }>;
      const paymentIndex = sameDealService.findIndex((r: any) => r.id === eventId);
      const index = paymentIndex >= 0 ? paymentIndex : 0;
      const firstInvoiceObj = parseISO(firstInvoiceDateStr);
      payableDate = format(addDays(firstInvoiceObj, index * 90), 'yyyy-MM-dd');
    } else {
      const accrualDateObj = parseISO(accrualDate);
      payableDate = format(addDays(accrualDateObj, payoutDelayDays), 'yyyy-MM-dd');
    }
  }

  const entryId = generateUUID();
  const month = accrualDate;
  const now = new Date().toISOString();
  const serviceId = event.service_id || null;

  db.prepare(`
    INSERT INTO commission_entries (
      id, deal_id, bdr_id, revenue_event_id, service_id, month,
      accrual_date, payable_date, amount, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entryId, event.deal_id, event.bdr_id, eventId, serviceId, month, accrualDate, payableDate, commissionAmount, 'accrued', now, now);

  return entryId;
}

export async function createRevenueEventsForDeal(dealId: string): Promise<void> {
  const db = getLocalDB();
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
  if (!deal) throw new Error('Deal not found');

  const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(dealId) as any[];
  if (services.length === 0) return;

  let firstInvoiceDate: Date;
  if (deal.first_invoice_date) {
    firstInvoiceDate = typeof deal.first_invoice_date === 'string' ? parseISO(deal.first_invoice_date) : new Date(deal.first_invoice_date);
  } else {
    const baseDate = deal.close_date || deal.proposal_date;
    if (!baseDate) throw new Error('Deal must have first_invoice_date, close_date, or proposal_date');
    firstInvoiceDate = addDays(typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate), 7);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const isRenewalDeal = deal.is_renewal === 1 || deal.is_renewal === true;
  const dealOriginalValue = Number(deal.original_deal_value ?? 0);
  const totalDealCommissionableValue = services.reduce((sum, s) => sum + Number(s.commissionable_value || 0), 0);

  for (const service of services) {
    const serviceMarkedRenewal = service.is_renewal === 1 || service.is_renewal === true;
    let serviceAmount = Number(service.commissionable_value || 0);
    let serviceBillingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal' = service.billing_type === 'mrr' ? 'monthly' :
      service.billing_type === 'quarterly' ? 'quarterly' : 'one_off';

    // Only services explicitly marked renewal get renewal treatment. Other services in the same
    // deal follow standard process (deposit, one_off, mrr, quarterly, paid_on_completion).
    const isRenewalService = serviceMarkedRenewal;
    let originalServiceValue: number;
    if (isRenewalService && (service.original_service_value != null && service.original_service_value > 0)) {
      originalServiceValue = Number(service.original_service_value);
    } else if (isRenewalService && isRenewalDeal && dealOriginalValue > 0) {
      // Service marked renewal, derive original from deal.original_deal_value when no per-service value
      if (services.length === 1) {
        originalServiceValue = dealOriginalValue;
      } else {
        const currentValue = Number(service.commissionable_value || 0);
        const proportion = totalDealCommissionableValue > 0 ? currentValue / totalDealCommissionableValue : 0;
        originalServiceValue = dealOriginalValue * proportion;
      }
    } else if (isRenewalService) {
      // Service marked renewal but no original value - skip to avoid commission on full amount
      continue;
    } else {
      originalServiceValue = 0; // Not a renewal - will use standard billing logic
    }
    if (isRenewalService) {
      const renewalServiceValue = Number(service.commissionable_value || 0);
      const serviceUplift = Math.max(0, renewalServiceValue - originalServiceValue);
      if (serviceUplift > 0) {
        serviceAmount = serviceUplift;
        serviceBillingType = 'renewal';
      } else continue;
    }

    // Renewals: single commission entry at 2.5% on uplift (regardless of deposit/one_off/mrr/quarterly billing)
    if (isRenewalService && serviceBillingType === 'renewal') {
      const closeDate = deal.close_date
        ? (typeof deal.close_date === 'string' ? parseISO(deal.close_date) : new Date(deal.close_date))
        : firstInvoiceDate;
      const renewalPayableDate = addDays(closeDate, 7);
      await createRevenueEvent(dealId, service.id, deal.bdr_id, serviceAmount, renewalPayableDate, 'renewal', 'renewal', true);
      continue;
    }

    // Deposit: 50/50 split (non-renewals only)
    if (service.billing_type === 'deposit') {
      const closeDate = deal.close_date ? (typeof deal.close_date === 'string' ? parseISO(deal.close_date) : new Date(deal.close_date)) : firstInvoiceDate;
      const firstHalfAmount = service.commissionable_value * 0.5;
      const firstHalfStage = closeDate <= today ? 'completion' : 'scheduled';
      await createRevenueEvent(dealId, service.id, deal.bdr_id, firstHalfAmount, closeDate, 'one_off', firstHalfStage, true);
      if (service.completion_date) {
        const secondHalfDate = typeof service.completion_date === 'string' ? parseISO(service.completion_date) : new Date(service.completion_date);
        const secondHalfStage = secondHalfDate <= today ? 'completion' : 'scheduled';
        await createRevenueEvent(dealId, service.id, deal.bdr_id, service.commissionable_value * 0.5, secondHalfDate, 'one_off', secondHalfStage, true);
      }
    } else if (service.billing_type === 'paid_on_completion') {
      const sourceDate = service.completion_date || deal.first_invoice_date;
      if (!sourceDate) continue;
      const completionDateStr = typeof sourceDate === 'string'
        ? sourceDate.split('T')[0]
        : format(new Date(sourceDate), 'yyyy-MM-dd');
      const completionDate = parseISO(completionDateStr);
      const paymentStage = completionDate <= today ? 'completion' : 'scheduled';
      await createRevenueEvent(dealId, service.id, deal.bdr_id, serviceAmount, completionDate, 'one_off', paymentStage, true);
    } else if (service.billing_type === 'one_off') {
      await createRevenueEvent(dealId, service.id, deal.bdr_id, serviceAmount, firstInvoiceDate, serviceBillingType, 'invoice', true);
    } else if (service.billing_type === 'mrr') {
      const contractMonths = service.contract_months || 12;
      const monthlyAmount = (service.monthly_price || 0) * (service.quantity || 1);
      for (let i = 0; i < contractMonths; i++) {
        // Calendar-month cadence prevents two MRR payments in one month.
        const paymentDate = addMonths(firstInvoiceDate, i);
        const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
        await createRevenueEvent(dealId, service.id, deal.bdr_id, monthlyAmount, paymentDate, serviceBillingType, paymentStage, true);
      }
    } else if (service.billing_type === 'quarterly') {
      const contractQuarters = service.contract_quarters || 4;
      const quarterlyAmount = (service.quarterly_price || 0) * (service.quantity || 1);
      for (let i = 0; i < contractQuarters; i++) {
        const paymentDate = addDays(firstInvoiceDate, i * 90);
        const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
        await createRevenueEvent(dealId, service.id, deal.bdr_id, quarterlyAmount, paymentDate, serviceBillingType, paymentStage, true);
      }
    } else if (service.billing_type === 'percentage_of_net_sales') {
      // Create placeholder commission entries directly (no revenue events - amount unknown until net sales data)
      // Same time frames as MRR: first period payable = close_date + 7 days (first_invoice_date), then 30-day cadence
      const contractMonths = service.contract_months || 12;
      const db = getLocalDB();
      const rules = db.prepare('SELECT payout_delay_days FROM commission_rules LIMIT 1').get() as { payout_delay_days?: number } | undefined;
      const payoutDelayDays = rules?.payout_delay_days ?? 30;
      for (let i = 0; i < contractMonths; i++) {
        const paymentDate = addDays(firstInvoiceDate, i * payoutDelayDays);
        const monthStr = format(startOfMonth(paymentDate), 'yyyy-MM-dd');
        const accrualDate = format(paymentDate, 'yyyy-MM-dd');
        const payableDate = accrualDate; // Same as MRR: first payable = close+7, subsequent = first_invoice + 30, 60, ...
        const entryId = generateUUID();
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO commission_entries (
            id, deal_id, bdr_id, service_id, month, accrual_date, payable_date, amount, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entryId, dealId, deal.bdr_id, service.id, monthStr, accrualDate, payableDate, null, 'accrued',
          now, now
        );
      }
    }
  }
}
