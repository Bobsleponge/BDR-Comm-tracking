/**
 * Local-DB-only revenue/commission logic for use in scripts.
 * Does NOT import server-only - safe for tsx/node execution.
 */

import { getLocalDB } from '@/lib/db/local-db';
import { generateUUID } from '@/lib/utils/uuid';
import { parseISO, addDays, format } from 'date-fns';

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

  const rules = db.prepare('SELECT * FROM commission_rules LIMIT 1').get() as any;
  const commissionRate = rules?.base_rate || 0.025;
  const commissionAmount = event.amount_collected * commissionRate;
  const payoutDelayDays = rules?.payout_delay_days || 30;

  const service = event.service_id
    ? db.prepare('SELECT * FROM deal_services WHERE id = ?').get(event.service_id) as any
    : null;
  const isDeposit = service?.billing_type === 'deposit';

  let accrualDate: string;
  let isDepositSecondHalf = false;
  if (isDeposit && deal.first_invoice_date && service?.completion_date) {
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
  // Renewals: full commission payable 7 days after close (existing business, not broken up)
  if (revBilling === 'renewal') {
    payableDate = accrualDate;
  } else if (isDepositSecondHalf || isFirstPayment) {
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
      payableDate = format(addDays(firstInvoiceObj, index * payoutDelayDays), 'yyyy-MM-dd');
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

  db.prepare(`
    INSERT INTO commission_entries (
      id, deal_id, bdr_id, revenue_event_id, month,
      accrual_date, payable_date, amount, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entryId, event.deal_id, event.bdr_id, eventId, month, accrualDate, payableDate, commissionAmount, 'accrued', now, now);

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

    // Determine if this service is a renewal (service-level OR deal-level with original value)
    let originalServiceValue: number;
    if (serviceMarkedRenewal && (service.original_service_value != null && service.original_service_value > 0)) {
      originalServiceValue = Number(service.original_service_value);
    } else if (isRenewalDeal && dealOriginalValue > 0) {
      // Deal-level renewal: derive original from deal.original_deal_value
      if (services.length === 1) {
        originalServiceValue = dealOriginalValue;
      } else {
        const currentValue = Number(service.commissionable_value || 0);
        const proportion = totalDealCommissionableValue > 0 ? currentValue / totalDealCommissionableValue : 0;
        originalServiceValue = dealOriginalValue * proportion;
      }
    } else if (serviceMarkedRenewal) {
      // Service marked renewal but no original value - skip to avoid commission on full amount
      continue;
    } else {
      originalServiceValue = 0; // Not a renewal
    }

    const isRenewalService = serviceMarkedRenewal || (isRenewalDeal && dealOriginalValue > 0);
    if (isRenewalService) {
      const renewalServiceValue = Number(service.commissionable_value || 0);
      const serviceUplift = Math.max(0, renewalServiceValue - originalServiceValue);
      if (serviceUplift > 0) {
        serviceAmount = serviceUplift;
        serviceBillingType = 'renewal';
      } else continue;
    }

    if (isRenewalService && serviceBillingType === 'renewal') {
      // Renewals: full commission payable 7 days after close (existing business, not spread like MRR/quarterly)
      const closeDate = deal.close_date
        ? (typeof deal.close_date === 'string' ? parseISO(deal.close_date) : new Date(deal.close_date))
        : firstInvoiceDate;
      const renewalPayableDate = addDays(closeDate, 7);
      await createRevenueEvent(dealId, service.id, deal.bdr_id, serviceAmount, renewalPayableDate, 'renewal', 'renewal', true);
    } else if (service.billing_type === 'one_off') {
      await createRevenueEvent(dealId, service.id, deal.bdr_id, serviceAmount, firstInvoiceDate, serviceBillingType, 'invoice', true);
    } else if (service.billing_type === 'mrr') {
      const contractMonths = service.contract_months || 12;
      const monthlyAmount = (service.monthly_price || 0) * (service.quantity || 1);
      for (let i = 0; i < contractMonths; i++) {
        const paymentDate = addDays(firstInvoiceDate, i * 30);
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
    } else if (service.billing_type === 'deposit') {
      const closeDate = deal.close_date ? (typeof deal.close_date === 'string' ? parseISO(deal.close_date) : new Date(deal.close_date)) : firstInvoiceDate;
      const firstHalfAmount = service.commissionable_value * 0.5;
      const firstHalfStage = closeDate <= today ? 'completion' : 'scheduled';
      await createRevenueEvent(dealId, service.id, deal.bdr_id, firstHalfAmount, closeDate, 'one_off', firstHalfStage, true);
      if (service.completion_date) {
        const secondHalfDate = typeof service.completion_date === 'string' ? parseISO(service.completion_date) : new Date(service.completion_date);
        const secondHalfStage = secondHalfDate <= today ? 'completion' : 'scheduled';
        await createRevenueEvent(dealId, service.id, deal.bdr_id, service.commissionable_value * 0.5, secondHalfDate, 'one_off', secondHalfStage, true);
      }
    }
  }
}
