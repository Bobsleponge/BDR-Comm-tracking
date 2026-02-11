import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { generateUUID } from '@/lib/utils/uuid';
import { parseISO, addDays, format } from 'date-fns';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Create a revenue event
 */
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
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const eventId = generateUUID();
    const collectionDateStr = format(collectionDate, 'yyyy-MM-dd'); // Use format to avoid timezone issues
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

  const supabase = await createClient() as any;
  const result = await supabase
    .from('revenue_events')
    .insert({
      deal_id: dealId,
      service_id: serviceId,
      bdr_id: bdrId,
      amount_collected: amountCollected,
      collection_date: collectionDate.toISOString().split('T')[0],
      billing_type: billingType,
      payment_stage: paymentStage,
      commissionable,
    })
    .select('id')
    .single();

  if (result.error) {
    throw new Error(`Failed to create revenue event: ${result.error.message}`);
  }

  return result.data.id;
}

/**
 * Process a revenue event to create commission entry
 */
export async function processRevenueEvent(eventId: string): Promise<string | null> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    // Get revenue event
    const event = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(eventId) as any;
    if (!event) {
      throw new Error('Revenue event not found');
    }

    if (!event.commissionable) {
      return null; // Not commissionable
    }

    // Skip if commission entry already exists (prevents duplicates on reprocess)
    const existing = db.prepare('SELECT id FROM commission_entries WHERE revenue_event_id = ?').get(eventId) as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }

    // Get deal to access close_date
    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(event.deal_id) as any;
    if (!deal) {
      throw new Error('Deal not found');
    }

    // Get commission rules
    const rules = db.prepare('SELECT * FROM commission_rules LIMIT 1').get() as any;
    if (!rules) {
      throw new Error('Commission rules not found');
    }

    // Calculate commission amount
    const commissionRate = rules.base_rate || 0.025;
    const commissionAmount = event.amount_collected * commissionRate;

    // Get payout delay days
    const payoutDelayDays = rules.payout_delay_days || 30;

    // Check if this is a deposit service - first 50% uses first_invoice_date, second 50% uses completion_date (collection_date)
    let accrualDate: string;
    const service = event.service_id 
      ? db.prepare('SELECT * FROM deal_services WHERE id = ?').get(event.service_id) as any
      : null;
    const isDeposit = service?.billing_type === 'deposit';
    
    let isDepositSecondHalf = false;
    if (isDeposit && deal.first_invoice_date && service?.completion_date) {
      const completionDateStr = typeof service.completion_date === 'string' 
        ? service.completion_date.split('T')[0] 
        : format(new Date(service.completion_date), 'yyyy-MM-dd');
      // Second 50% has collection_date = completion_date - use that so it loads into the correct month
      if (event.collection_date === completionDateStr) {
        accrualDate = event.collection_date;
        isDepositSecondHalf = true;
      } else {
        // First 50% - use first_invoice_date for commission allocation
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
    
    // Calculate payable_date:
    // - Deposit second 50%: payable on completion date (no delay)
    // - First payment (one-off, renewal, first MRR/quarterly): payable on first_invoice_date (no delay)
    // - MRR subsequent: 30-day cadence from first claim - payable = first_invoice_date + (index * 30)
    // - Quarterly subsequent: 90-day cadence - payable = first_invoice_date + (index * 90)
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
        // MRR: 30-day cadence from first claim (Jan 7, Feb 6, Mar 8, Apr 7...)
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
        // Quarterly: 90-day cadence from first claim
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

    // Create commission entry
    const entryId = generateUUID();
    const month = accrualDate; // Month for BDR allocation
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO commission_entries (
        id, deal_id, bdr_id, revenue_event_id, month,
        accrual_date, payable_date, amount, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entryId, event.deal_id, event.bdr_id, eventId, month,
      accrualDate, payableDate, commissionAmount, 'accrued',
      now, now
    );

    return entryId;
  }

  const supabase = await createClient() as any;
  const eventResult = await supabase
    .from('revenue_events')
    .select('*')
    .eq('id', eventId)
    .single();

  if (eventResult.error || !eventResult.data) {
    throw new Error('Revenue event not found');
  }

  const event = eventResult.data;
  if (!event.commissionable) {
    return null;
  }

  // Skip if commission entry already exists (prevents duplicates on reprocess)
  const existingResult = await supabase
    .from('commission_entries')
    .select('id')
    .eq('revenue_event_id', eventId)
    .single();
  if (!existingResult.error && existingResult.data) {
    return existingResult.data.id;
  }

  // Get deal to access close_date
  const dealResult = await supabase
    .from('deals')
    .select('*')
    .eq('id', event.deal_id)
    .single();

  if (dealResult.error || !dealResult.data) {
    throw new Error('Deal not found');
  }

  const deal = dealResult.data;

  // Get commission rules
  const rulesResult = await supabase
    .from('commission_rules')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (rulesResult.error || !rulesResult.data) {
    throw new Error('Commission rules not found');
  }

  const rules = rulesResult.data;
  const commissionRate = rules.base_rate || 0.025;
  const commissionAmount = event.amount_collected * commissionRate;
  const payoutDelayDays = rules.payout_delay_days || 30;

  // Check if this is a deposit service - first 50% uses first_invoice_date, second 50% uses completion_date (collection_date)
  let accrualDate: string;
  let service = null;
  if (event.service_id) {
    const serviceResult = await supabase
      .from('deal_services')
      .select('*')
      .eq('id', event.service_id)
      .single();
    if (!serviceResult.error) {
      service = serviceResult.data;
    }
  }
  const isDeposit = service?.billing_type === 'deposit';
  
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

  // payable_date: renewal = 7 days after close (full commission, no spread). Deposit/second 50%/first payment: no delay. MRR: 30-day cadence. Quarterly: 90-day cadence.
  const firstInvoiceDateStr = deal.first_invoice_date
    ? (typeof deal.first_invoice_date === 'string' ? deal.first_invoice_date.split('T')[0] : format(new Date(deal.first_invoice_date), 'yyyy-MM-dd'))
    : null;
  const isFirstPayment = firstInvoiceDateStr && accrualDate === firstInvoiceDateStr;

  let payableDate: string;
  const revBilling = (event.billing_type || service?.billing_type || '').toLowerCase();
  if (revBilling === 'renewal') {
    payableDate = accrualDate;
  } else if (isDepositSecondHalf || isFirstPayment) {
    payableDate = accrualDate;
  } else {
    if ((revBilling === 'monthly' || revBilling === 'mrr') && firstInvoiceDateStr) {
      const { data: sameDealService } = await supabase.from('revenue_events')
        .select('id, collection_date')
        .eq('deal_id', event.deal_id)
        .eq('service_id', event.service_id || '')
        .eq('commissionable', true)
        .order('collection_date');
      const paymentIndex = (sameDealService || []).findIndex((r: any) => r.id === eventId);
      const index = paymentIndex >= 0 ? paymentIndex : 0;
      const firstInvoiceObj = parseISO(firstInvoiceDateStr);
      payableDate = format(addDays(firstInvoiceObj, index * payoutDelayDays), 'yyyy-MM-dd');
    } else if ((revBilling === 'quarterly') && firstInvoiceDateStr) {
      const { data: sameDealService } = await supabase.from('revenue_events')
        .select('id, collection_date')
        .eq('deal_id', event.deal_id)
        .eq('service_id', event.service_id || '')
        .eq('commissionable', true)
        .order('collection_date');
      const paymentIndex = (sameDealService || []).findIndex((r: any) => r.id === eventId);
      const index = paymentIndex >= 0 ? paymentIndex : 0;
      const firstInvoiceObj = parseISO(firstInvoiceDateStr);
      payableDate = format(addDays(firstInvoiceObj, index * 90), 'yyyy-MM-dd');
    } else {
      const accrualDateObj = parseISO(accrualDate);
      payableDate = format(addDays(accrualDateObj, payoutDelayDays), 'yyyy-MM-dd');
    }
  }

  const entryResult = await supabase
    .from('commission_entries')
    .insert({
      deal_id: event.deal_id,
      bdr_id: event.bdr_id,
      revenue_event_id: eventId,
      month: accrualDate,
      accrual_date: accrualDate,
      payable_date: payableDate,
      amount: commissionAmount,
      status: 'accrued',
    })
    .select('id')
    .single();

  if (entryResult.error) {
    throw new Error(`Failed to create commission entry: ${entryResult.error.message}`);
  }

  return entryResult.data.id;
}

/**
 * Create revenue events for all services in a deal
 */
export async function createRevenueEventsForDeal(dealId: string): Promise<void> {
  // Get first_invoice_date (when first payment is received - close_date + 7 days grace period)
  // This is the date when money actually arrives in the account
  const getFirstInvoiceDate = (deal: any): Date => {
    if (deal.first_invoice_date) {
      return typeof deal.first_invoice_date === 'string' 
        ? parseISO(deal.first_invoice_date) 
        : new Date(deal.first_invoice_date);
    }
    // Fallback: calculate from close_date + 7 days if first_invoice_date not set
    const baseDate = deal.close_date || deal.proposal_date;
    if (!baseDate) {
      throw new Error('Deal must have either first_invoice_date, close_date, or proposal_date');
    }
    const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
    return addDays(baseDateObj, 7);
  };

  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    // Get deal
    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
    if (!deal) {
      throw new Error('Deal not found');
    }

    // Get deal services
    const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(dealId) as any[];

    if (services.length === 0) {
      // No services, skip
      return;
    }

    // Get first_invoice_date (when first payment is received - close_date + 7 days grace period)
    // This is the date when money actually arrives in the account
    let firstInvoiceDate: Date;
    if (deal.first_invoice_date) {
      firstInvoiceDate = typeof deal.first_invoice_date === 'string' 
        ? parseISO(deal.first_invoice_date) 
        : new Date(deal.first_invoice_date);
    } else {
      // Fallback: calculate from close_date + 7 days if first_invoice_date not set
      const baseDate = deal.close_date || deal.proposal_date;
      if (!baseDate) {
        throw new Error('Deal must have either first_invoice_date, close_date, or proposal_date');
      }
      const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
      firstInvoiceDate = addDays(baseDateObj, 7);
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const isRenewalDeal = deal.is_renewal === 1 || deal.is_renewal === true;
    const dealOriginalValue = Number(deal.original_deal_value ?? 0);
    const totalDealCommissionableValue = services.reduce((sum: number, s: any) => sum + Number(s.commissionable_value || 0), 0);

    // Create revenue events for each service based on billing type
    for (const service of services) {
      const serviceMarkedRenewal = service.is_renewal === 1 || service.is_renewal === true;
      let serviceAmount = Number(service.commissionable_value || 0);
      let serviceBillingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal' = service.billing_type === 'mrr' ? 'monthly' : 
                                                                                service.billing_type === 'quarterly' ? 'quarterly' : 'one_off';
      
      // Determine original value for uplift: service-level, or deal-level fallback
      let originalServiceValue: number;
      if (serviceMarkedRenewal && (service.original_service_value != null && service.original_service_value > 0)) {
        originalServiceValue = Number(service.original_service_value);
      } else if (isRenewalDeal && dealOriginalValue > 0) {
        if (services.length === 1) {
          originalServiceValue = dealOriginalValue;
        } else {
          const currentValue = Number(service.commissionable_value || 0);
          const proportion = totalDealCommissionableValue > 0 ? currentValue / totalDealCommissionableValue : 0;
          originalServiceValue = dealOriginalValue * proportion;
        }
      } else if (serviceMarkedRenewal) {
        continue; // Service marked renewal but no original value - skip to avoid commission on full amount
      } else {
        originalServiceValue = 0;
      }

      const isRenewalService = serviceMarkedRenewal || (isRenewalDeal && dealOriginalValue > 0);
      if (isRenewalService) {
        const renewalServiceValue = Number(service.commissionable_value || 0);
        const serviceUplift = Math.max(0, renewalServiceValue - originalServiceValue);
        
        if (serviceUplift > 0) {
          serviceAmount = serviceUplift;
          serviceBillingType = 'renewal';
        } else {
          continue;
        }
      }
      
      if (isRenewalService && serviceBillingType === 'renewal') {
        // Renewals: full commission payable 7 days after close (existing business, not spread like MRR/quarterly)
        const closeDate = deal.close_date
          ? (typeof deal.close_date === 'string' ? parseISO(deal.close_date) : new Date(deal.close_date))
          : firstInvoiceDate;
        const renewalPayableDate = addDays(closeDate, 7);
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          serviceAmount,
          renewalPayableDate,
          'renewal',
          'renewal',
          true
        );
      } else if (service.billing_type === 'one_off') {
        // One-off: revenue collected on first_invoice_date (after 7-day grace period)
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          serviceAmount,
          firstInvoiceDate,
          serviceBillingType,
          'invoice',
          true
        );
      } else if (service.billing_type === 'mrr') {
        // Monthly recurring: first payment on first_invoice_date, then every 30 days from there
        const contractMonths = service.contract_months || 12;
        const monthlyAmount = (service.monthly_price || 0) * (service.quantity || 1);
        
        for (let i = 0; i < contractMonths; i++) {
          const paymentDate = addDays(firstInvoiceDate, i * 30); // First: +0 days, then +30, +60, +90...
          const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
          
          await createRevenueEvent(
            dealId,
            service.id,
            deal.bdr_id,
            monthlyAmount,
            paymentDate,
            serviceBillingType,
            paymentStage,
            true
          );
        }
      } else if (service.billing_type === 'quarterly') {
        // Quarterly recurring: first payment on first_invoice_date, then every 90 days from there
        const contractQuarters = service.contract_quarters || 4;
        const quarterlyAmount = (service.quarterly_price || 0) * (service.quantity || 1);
        
        for (let i = 0; i < contractQuarters; i++) {
          const paymentDate = addDays(firstInvoiceDate, i * 90); // First: +0 days, then +90, +180, +270...
          const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
          
          await createRevenueEvent(
            dealId,
            service.id,
            deal.bdr_id,
            quarterlyAmount,
            paymentDate,
            serviceBillingType,
            paymentStage,
            true
          );
        }
      } else if (service.billing_type === 'deposit') {
        // Deposit: 50/50 split
        // First 50%: revenue collected on close_date, but commission allocated based on first_invoice_date
        const closeDate = deal.close_date 
          ? (typeof deal.close_date === 'string' ? parseISO(deal.close_date) : new Date(deal.close_date))
          : firstInvoiceDate;
        const firstHalfAmount = service.commissionable_value * 0.5;
        const firstHalfDate = closeDate; // Collection date is close_date
        const firstHalfStage = firstHalfDate <= today ? 'completion' : 'scheduled';
        
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          firstHalfAmount,
          firstHalfDate,
          'one_off',
          firstHalfStage,
          true
        );
        
        // Second 50%: collected on completion_date (scheduled when creating the deal)
        if (service.completion_date) {
          const secondHalfAmount = service.commissionable_value * 0.5;
          const secondHalfDate = typeof service.completion_date === 'string' 
            ? parseISO(service.completion_date) 
            : new Date(service.completion_date);
          const secondHalfStage = secondHalfDate <= today ? 'completion' : 'scheduled';
          
          await createRevenueEvent(
            dealId,
            service.id,
            deal.bdr_id,
            secondHalfAmount,
            secondHalfDate,
            'one_off',
            secondHalfStage,
            true
          );
        }
      }
    }
  } else {
    // Supabase mode - create revenue events for deal services
    const supabase = await createClient() as any;
    const dealResult = await supabase
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .single();

    if (dealResult.error || !dealResult.data) {
      throw new Error('Deal not found');
    }

    const deal = dealResult.data;
    
    const servicesResult = await supabase
      .from('deal_services')
      .select('*')
      .eq('deal_id', dealId);

    if (servicesResult.error || !servicesResult.data || servicesResult.data.length === 0) {
      return;
    }

    // Get first_invoice_date (when first payment is received - close_date + 7 days grace period)
    // This is the date when money actually arrives in the account
    let firstInvoiceDate: Date;
    if (deal.first_invoice_date) {
      firstInvoiceDate = typeof deal.first_invoice_date === 'string' 
        ? parseISO(deal.first_invoice_date) 
        : new Date(deal.first_invoice_date);
    } else {
      // Fallback: calculate from close_date + 7 days if first_invoice_date not set
      const baseDate = deal.close_date || deal.proposal_date;
      if (!baseDate) {
        throw new Error('Deal must have either first_invoice_date, close_date, or proposal_date');
      }
      const baseDateObj = typeof baseDate === 'string' ? parseISO(baseDate) : new Date(baseDate);
      firstInvoiceDate = addDays(baseDateObj, 7);
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const isRenewalDeal = deal.is_renewal === true || deal.is_renewal === 1;
    const dealOriginalValue = Number(deal.original_deal_value ?? 0);
    const totalDealCommissionableValue = (servicesResult.data || []).reduce((sum: number, s: any) => sum + Number(s.commissionable_value || 0), 0);

    for (const service of servicesResult.data) {
      const serviceMarkedRenewal = service.is_renewal === true || service.is_renewal === 1;
      let serviceAmount = Number(service.commissionable_value || 0);
      let serviceBillingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal' = service.billing_type === 'mrr' ? 'monthly' : 
                                                                                service.billing_type === 'quarterly' ? 'quarterly' : 'one_off';
      
      let originalServiceValue: number;
      if (serviceMarkedRenewal && (service.original_service_value != null && service.original_service_value > 0)) {
        originalServiceValue = Number(service.original_service_value);
      } else if (isRenewalDeal && dealOriginalValue > 0) {
        if (servicesResult.data!.length === 1) {
          originalServiceValue = dealOriginalValue;
        } else {
          const currentValue = Number(service.commissionable_value || 0);
          const proportion = totalDealCommissionableValue > 0 ? currentValue / totalDealCommissionableValue : 0;
          originalServiceValue = dealOriginalValue * proportion;
        }
      } else if (serviceMarkedRenewal) {
        continue;
      } else {
        originalServiceValue = 0;
      }

      const isRenewalService = serviceMarkedRenewal || (isRenewalDeal && dealOriginalValue > 0);
      if (isRenewalService) {
        const renewalServiceValue = Number(service.commissionable_value || 0);
        const serviceUplift = Math.max(0, renewalServiceValue - originalServiceValue);
        
        if (serviceUplift > 0) {
          serviceAmount = serviceUplift;
          serviceBillingType = 'renewal';
        } else {
          continue;
        }
      }
      
      if (isRenewalService && serviceBillingType === 'renewal') {
        // Renewals: full commission payable 7 days after close (existing business, not spread like MRR/quarterly)
        const closeDate = deal.close_date
          ? (typeof deal.close_date === 'string' ? parseISO(deal.close_date) : new Date(deal.close_date))
          : firstInvoiceDate;
        const renewalPayableDate = addDays(closeDate, 7);
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          serviceAmount,
          renewalPayableDate,
          'renewal',
          'renewal',
          true
        );
      } else if (service.billing_type === 'one_off') {
        // One-off: revenue collected on first_invoice_date (after 7-day grace period)
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          serviceAmount,
          firstInvoiceDate,
          serviceBillingType,
          'invoice',
          true
        );
      } else if (service.billing_type === 'mrr') {
        // Monthly recurring: first payment on first_invoice_date, then every 30 days from there
        const contractMonths = service.contract_months || 12;
        const monthlyAmount = (service.monthly_price || 0) * (service.quantity || 1);
        
        for (let i = 0; i < contractMonths; i++) {
          const paymentDate = addDays(firstInvoiceDate, i * 30); // First: +0 days, then +30, +60, +90...
          const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
          
          await createRevenueEvent(
            dealId,
            service.id,
            deal.bdr_id,
            monthlyAmount,
            paymentDate,
            serviceBillingType,
            paymentStage,
            true
          );
        }
      } else if (service.billing_type === 'quarterly') {
        // Quarterly recurring: first payment on first_invoice_date, then every 90 days from there
        const contractQuarters = service.contract_quarters || 4;
        const quarterlyAmount = (service.quarterly_price || 0) * (service.quantity || 1);
        
        for (let i = 0; i < contractQuarters; i++) {
          const paymentDate = addDays(firstInvoiceDate, i * 90); // First: +0 days, then +90, +180, +270...
          const paymentStage = paymentDate <= today ? 'invoice' : 'scheduled';
          
          await createRevenueEvent(
            dealId,
            service.id,
            deal.bdr_id,
            quarterlyAmount,
            paymentDate,
            serviceBillingType,
            paymentStage,
            true
          );
        }
      } else if (service.billing_type === 'deposit') {
        // Deposit: 50/50 split
        // First 50%: collected on close_date (same day as closing, to keep it in the same month)
        // Note: Commission payable date is still calculated separately and may be 7+ days after
        const closeDate = deal.close_date 
          ? (typeof deal.close_date === 'string' ? parseISO(deal.close_date) : new Date(deal.close_date))
          : firstInvoiceDate;
        const firstHalfAmount = service.commissionable_value * 0.5;
        const firstHalfDate = closeDate;
        const firstHalfStage = firstHalfDate <= today ? 'completion' : 'scheduled';
        
        await createRevenueEvent(
          dealId,
          service.id,
          deal.bdr_id,
          firstHalfAmount,
          firstHalfDate,
          'one_off',
          firstHalfStage,
          true
        );
        
        // Second 50%: collected on completion_date (scheduled when creating the deal)
        if (service.completion_date) {
          const secondHalfAmount = service.commissionable_value * 0.5;
          const secondHalfDate = typeof service.completion_date === 'string' 
            ? parseISO(service.completion_date) 
            : new Date(service.completion_date);
          const secondHalfStage = secondHalfDate <= today ? 'completion' : 'scheduled';
          
          await createRevenueEvent(
            dealId,
            service.id,
            deal.bdr_id,
            secondHalfAmount,
            secondHalfDate,
            'one_off',
            secondHalfStage,
            true
          );
        }
      }
    }
  }
}
