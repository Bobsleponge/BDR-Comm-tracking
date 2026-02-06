import { addMonths, addDays, startOfMonth, format, parseISO } from 'date-fns';
import { createClient } from '@/lib/supabase/server';
import { generateUUID } from '@/lib/utils/uuid';
import type { Database } from '@/types/database';
import { getQuarterFromDate, parseQuarter } from './calculator';

type RevenueEvent = Database['public']['Tables']['revenue_events']['Insert'];
type RevenueEventRow = Database['public']['Tables']['revenue_events']['Row'];
type CommissionEntry = Database['public']['Tables']['commission_entries']['Insert'];
type Deal = Database['public']['Tables']['deals']['Row'];
type DealService = Database['public']['Tables']['deal_services']['Row'];
type CommissionRules = Database['public']['Tables']['commission_rules']['Row'];

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Create a single revenue event
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

    const id = generateUUID();
    const collectionDateStr = format(collectionDate, 'yyyy-MM-dd');

    db.prepare(`
      INSERT INTO revenue_events (
        id, deal_id, service_id, bdr_id, amount_collected, 
        collection_date, billing_type, payment_stage, commissionable,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id,
      dealId,
      serviceId,
      bdrId,
      amountCollected,
      collectionDateStr,
      billingType,
      paymentStage,
      commissionable ? 1 : 0
    );

    return id;
  }

  const supabase = await createClient();
  const revenueEvent: RevenueEvent = {
    deal_id: dealId,
    service_id: serviceId,
    bdr_id: bdrId,
    amount_collected: amountCollected,
    collection_date: format(collectionDate, 'yyyy-MM-dd'),
    billing_type: billingType,
    payment_stage: paymentStage,
    commissionable,
  };

  const { data, error } = await (supabase
    .from('revenue_events')
    .insert(revenueEvent)
    .select('id')
    .single() as any);

  if (error) {
    throw new Error(`Failed to create revenue event: ${error.message}`);
  }

  return data.id;
}

/**
 * Process a revenue event and create commission entry if commissionable
 */
export async function processRevenueEvent(revenueEventId: string): Promise<string | null> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const revenueEvent = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(revenueEventId) as any;
    if (!revenueEvent) {
      throw new Error('Revenue event not found');
    }

    if (!revenueEvent.commissionable) {
      return null;
    }

    // Process ALL revenue events (past, present, and future) for planning and prediction
    // This allows the system to guide billing and provide accurate commission schedules
    const today = new Date();
    const collectionDate = parseISO(revenueEvent.collection_date);

    // Check if commission entry already exists for this revenue event
    const existingEntry = db.prepare('SELECT id FROM commission_entries WHERE revenue_event_id = ?').get(revenueEventId) as any;
    if (existingEntry) {
      // Commission entry already exists, don't create duplicate
      return existingEntry.id;
    }

    // Get commission rules
    const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
    if (!rules) {
      throw new Error('Commission rules not found');
    }

    // Get deal to check close_date for one-off services
    const deal = db.prepare('SELECT close_date FROM deals WHERE id = ?').get(revenueEvent.deal_id) as any;
    
    const accrualDate = collectionDate; // Already parsed above
    let payableDate: Date;
    
    // For one-off services, payable date is 5 days after close date
    if (revenueEvent.billing_type === 'one_off' && deal?.close_date) {
      const closeDate = parseISO(deal.close_date);
      payableDate = addDays(closeDate, 5);
    } else {
      // For other billing types, use payout_delay_days from commission rules
      const payoutDelayDays = rules.payout_delay_days || 30;
      payableDate = addDays(collectionDate, payoutDelayDays);
    }

    // Calculate commission amount
    const commissionAmount = await calculateCommissionFromRevenueEvent(revenueEventId);

    // Check if BDR is still eligible (not left or trailing commission allowed)
    const bdr = db.prepare('SELECT * FROM bdr_reps WHERE id = ?').get(revenueEvent.bdr_id) as any;
    if (bdr && bdr.leave_date) {
      const leaveDate = parseISO(bdr.leave_date);
      if (collectionDate > leaveDate && !bdr.allow_trailing_commission) {
        // Don't create commission entry if BDR left and trailing commission not allowed
        return null;
      }
    }

    // Determine status based on payable date (today already defined above)
    const status = payableDate <= today ? 'payable' : 'accrued';

    // Create commission entry
    const commissionEntryId = generateUUID();
    const monthStr = format(startOfMonth(collectionDate), 'yyyy-MM-dd');

    db.prepare(`
      INSERT INTO commission_entries (
        id, deal_id, bdr_id, revenue_event_id, month, amount,
        accrual_date, payable_date, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      commissionEntryId,
      revenueEvent.deal_id,
      revenueEvent.bdr_id,
      revenueEventId,
      monthStr,
      commissionAmount,
      format(accrualDate, 'yyyy-MM-dd'),
      format(payableDate, 'yyyy-MM-dd'),
      status
    );

    return commissionEntryId;
  }

  const supabase = await createClient();

  // Get revenue event
  const revenueEventQuery = (supabase as any)
    .from('revenue_events')
    .select('*')
    .eq('id', revenueEventId)
    .single();
  const { data: revenueEvent, error: eventError } = (await revenueEventQuery) as { data: any; error: any };

  if (eventError || !revenueEvent) {
    throw new Error(`Revenue event not found: ${eventError?.message}`);
  }

  if (!revenueEvent.commissionable) {
    return null;
  }

  // Process ALL revenue events (past, present, and future) for planning and prediction
  // This allows the system to guide billing and provide accurate commission schedules
  const todaySupabase = new Date();
  const collectionDateSupabase = parseISO(revenueEvent.collection_date);

  // Check if commission entry already exists for this revenue event
  const existingEntryQuery = (supabase as any)
    .from('commission_entries')
    .select('id')
    .eq('revenue_event_id', revenueEventId)
    .single();
  const { data: existingEntry } = (await existingEntryQuery) as { data: any; error: any };
  
  if (existingEntry) {
    // Commission entry already exists, don't create duplicate
    return existingEntry.id;
  }

  // Get commission rules
  const rulesQuery = (supabase as any)
    .from('commission_rules')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();
  const { data: rules, error: rulesError } = (await rulesQuery) as { data: any; error: any };

  if (rulesError || !rules) {
    throw new Error(`Commission rules not found: ${rulesError?.message}`);
  }

  // Get deal to check close_date for one-off services
  const dealQuery = (supabase as any)
    .from('deals')
    .select('close_date')
    .eq('id', revenueEvent.deal_id)
    .single();
  const { data: deal } = (await dealQuery) as { data: any; error: any };

  const accrualDate = collectionDateSupabase; // Already parsed above
  let payableDate: Date;
  
  // For one-off services, payable date is 5 days after close date
  if (revenueEvent.billing_type === 'one_off' && deal?.close_date) {
    const closeDate = parseISO(deal.close_date);
    payableDate = addDays(closeDate, 5);
  } else {
    // For other billing types, use payout_delay_days from commission rules
    const payoutDelayDays = rules.payout_delay_days || 30;
    payableDate = addDays(collectionDateSupabase, payoutDelayDays);
  }

  // Calculate commission amount
  const commissionAmount = await calculateCommissionFromRevenueEvent(revenueEventId);

  // Check if BDR is still eligible
  const bdrQuery = (supabase as any)
    .from('bdr_reps')
    .select('*')
    .eq('id', revenueEvent.bdr_id)
    .single();
  const { data: bdr } = (await bdrQuery) as { data: any; error: any };

  if (bdr?.leave_date) {
    const leaveDate = parseISO(bdr.leave_date);
    if (collectionDateSupabase > leaveDate && !bdr.allow_trailing_commission) {
      return null;
    }
  }

  // Determine status (todaySupabase already defined above)
  const status = payableDate <= todaySupabase ? 'payable' : 'accrued';

  // Create commission entry
  const monthStr = format(startOfMonth(collectionDateSupabase), 'yyyy-MM-dd');

  const commissionEntry: CommissionEntry = {
    deal_id: revenueEvent.deal_id,
    bdr_id: revenueEvent.bdr_id,
    revenue_event_id: revenueEventId,
    month: monthStr,
    amount: commissionAmount,
    accrual_date: format(accrualDate, 'yyyy-MM-dd'),
    payable_date: format(payableDate, 'yyyy-MM-dd'),
    status,
  };

  const { data: entry, error: entryError } = await (supabase
    .from('commission_entries')
    .insert(commissionEntry)
    .select('id')
    .single() as any);

  if (entryError) {
    throw new Error(`Failed to create commission entry: ${entryError.message}`);
  }

  return entry.id;
}

/**
 * Calculate commission amount for a revenue event
 */
export async function calculateCommissionFromRevenueEvent(revenueEventId: string): Promise<number> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const revenueEvent = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(revenueEventId) as any;
    if (!revenueEvent) {
      throw new Error('Revenue event not found');
    }

    if (!revenueEvent.commissionable) {
      return 0;
    }

    // Get commission rate for this event
    const rate = await getCommissionRateForRevenueEvent(revenueEventId);

    // For tiered commission, we need cumulative revenue
    const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
    if (rules?.tier_1_threshold && rules?.tier_1_rate && rules?.tier_2_rate) {
      // Calculate cumulative revenue before this event
      const cumulativeBefore = db.prepare(`
        SELECT COALESCE(SUM(amount_collected), 0) as total
        FROM revenue_events
        WHERE bdr_id = ? AND collection_date < ? AND commissionable = 1
      `).get(revenueEvent.bdr_id, revenueEvent.collection_date) as { total: number };

      const { calculateTieredCommission } = await import('./calculator');
      return calculateTieredCommission(
        revenueEvent.amount_collected,
        cumulativeBefore.total || 0,
        rules.tier_1_threshold,
        rules.tier_1_rate,
        rules.tier_2_rate
      );
    }

    return revenueEvent.amount_collected * rate;
  }

  const supabase = await createClient();

  // @ts-ignore - Supabase type complexity issue
  const revenueEventQuery = (supabase as any)
    .from('revenue_events')
    .select('*')
    .eq('id', revenueEventId)
    .single();
  const { data: revenueEvent, error } = (await revenueEventQuery) as { data: any; error: any };

  if (error || !revenueEvent) {
    throw new Error(`Revenue event not found: ${error?.message}`);
  }

  if (!revenueEvent.commissionable) {
    return 0;
  }

  const rate = await getCommissionRateForRevenueEvent(revenueEventId);

  // Check for tiered commission
  // @ts-ignore - Supabase type complexity issue
  const rulesQuery = (supabase as any)
    .from('commission_rules')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();
  const { data: rules } = (await rulesQuery) as { data: any; error: any };

  if (rules?.tier_1_threshold && rules?.tier_1_rate && rules?.tier_2_rate) {
    // Get cumulative revenue before this event
    // @ts-ignore - Supabase type complexity issue
    const cumulativeQuery = (supabase as any)
      .from('revenue_events')
      .select('amount_collected')
      .eq('bdr_id', revenueEvent.bdr_id)
      .eq('commissionable', true)
      .lt('collection_date', revenueEvent.collection_date);
    const { data: cumulativeData } = (await cumulativeQuery) as { data: any[] | null; error: any };

    const cumulativeBefore = (cumulativeData || []).reduce(
      (sum: number, e: any) => sum + (e.amount_collected || 0),
      0
    );

    const { calculateTieredCommission } = await import('./calculator');
    return calculateTieredCommission(
      revenueEvent.amount_collected,
      cumulativeBefore,
      rules.tier_1_threshold,
      rules.tier_1_rate,
      rules.tier_2_rate
    );
  }

  return revenueEvent.amount_collected * rate;
}

/**
 * Get commission rate for a revenue event
 */
export async function getCommissionRateForRevenueEvent(revenueEventId: string): Promise<number> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const revenueEvent = db.prepare('SELECT * FROM revenue_events WHERE id = ?').get(revenueEventId) as any;
    if (!revenueEvent) {
      throw new Error('Revenue event not found');
    }

    // Get commission rules
    const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
    if (!rules) {
      throw new Error('Commission rules not found');
    }

    // For renewals, use renewal rate
    if (revenueEvent.billing_type === 'renewal') {
      return rules.renewal_rate || 0.025;
    }

    // Check if service has custom rate
    if (revenueEvent.service_id) {
      const service = db.prepare('SELECT * FROM deal_services WHERE id = ?').get(revenueEvent.service_id) as any;
      if (service?.commission_rate) {
        return service.commission_rate;
      }

      // Check service type pricing
      const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(revenueEvent.deal_id) as any;
      if (deal) {
        const servicePricing = db.prepare('SELECT * FROM service_pricing WHERE service_type = ?').get(deal.service_type) as any;
        if (servicePricing?.commission_percent) {
          return servicePricing.commission_percent;
        }
      }
    }

    return rules.base_rate;
  }

  const supabase = await createClient();

  // @ts-ignore - Supabase type complexity issue
  const revenueEventQuery = (supabase as any)
    .from('revenue_events')
    .select('*, deal_services(*), deals(*)')
    .eq('id', revenueEventId)
    .single();
  const { data: revenueEvent, error } = (await revenueEventQuery) as { data: any; error: any };

  if (error || !revenueEvent) {
    throw new Error(`Revenue event not found: ${error?.message}`);
  }

  // Get commission rules
  // @ts-ignore - Supabase type complexity issue
  const rulesQuery = (supabase as any)
    .from('commission_rules')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();
  const { data: rules } = (await rulesQuery) as { data: any; error: any };

  if (!rules) {
    throw new Error('Commission rules not found');
  }

  // For renewals, use renewal rate
  if (revenueEvent.billing_type === 'renewal') {
    return rules.renewal_rate || 0.025;
  }

  // Check service custom rate
  if (revenueEvent.service_id && revenueEvent.deal_services) {
    const service = revenueEvent.deal_services;
    if (service.commission_rate) {
      return service.commission_rate;
    }
  }

  // Check service type pricing
  if (revenueEvent.deals) {
    // @ts-ignore - Supabase type complexity issue
    const { data: servicePricing } = await (supabase
      .from('service_pricing')
      .select('*')
      .eq('service_type', revenueEvent.deals.service_type)
      .single() as any);

    if (servicePricing?.commission_percent) {
      return servicePricing.commission_percent;
    }
  }

  return rules.base_rate;
}

/**
 * Handle 50/50 payment structure for deposit services
 */
export async function handle50_50Payment(
  dealId: string,
  serviceId: string,
  bdrId: string,
  totalAmount: number,
  invoiceDate: Date,
  completionDate: Date | null
): Promise<string[]> {
  const eventIds: string[] = [];

  // First payment: 50% at invoice date
  const firstEventId = await createRevenueEvent(
    dealId,
    serviceId,
    bdrId,
    totalAmount / 2,
    invoiceDate,
    'one_off', // Individual payment events are one_off, but linked to deposit service
    'invoice',
    true
  );
  eventIds.push(firstEventId);

  // Second payment: 50% at completion date (or invoice + 60 days)
  const secondPaymentDate = completionDate || addDays(invoiceDate, 60);
  const secondEventId = await createRevenueEvent(
    dealId,
    serviceId,
    bdrId,
    totalAmount / 2,
    secondPaymentDate,
    'one_off', // Individual payment events are one_off, but linked to deposit service
    'completion',
    true
  );
  eventIds.push(secondEventId);

  return eventIds;
}

/**
 * Check if a revenue event already exists for the given parameters
 */
async function checkRevenueEventExists(
  dealId: string,
  serviceId: string | null,
  collectionDate: Date,
  billingType: 'one_off' | 'monthly' | 'quarterly' | 'renewal'
): Promise<boolean> {
  const collectionDateStr = format(collectionDate, 'yyyy-MM-dd');
  
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();
    
    const existing = db.prepare(`
      SELECT id FROM revenue_events 
      WHERE deal_id = ? 
        AND service_id IS ? 
        AND collection_date = ? 
        AND billing_type = ?
    `).get(dealId, serviceId, collectionDateStr, billingType) as any;
    
    return !!existing;
  }
  
  const supabase = await createClient();
  const { data, error } = await (supabase
    .from('revenue_events')
    .select('id')
    .eq('deal_id', dealId)
    .eq('service_id', serviceId)
    .eq('collection_date', collectionDateStr)
    .eq('billing_type', billingType)
    .limit(1)
    .single() as any);
  
  return !error && !!data;
}

/**
 * Schedule monthly recurring revenue events
 */
export async function scheduleMonthlyRevenueEvents(
  dealId: string,
  serviceId: string,
  bdrId: string,
  monthlyAmount: number,
  startDate: Date,
  contractMonths: number
): Promise<string[]> {
  const eventIds: string[] = [];
  const startMonth = startOfMonth(startDate);
  const today = new Date();

  for (let i = 0; i < contractMonths; i++) {
    const collectionDate = addMonths(startMonth, i);
    
    // Check if this revenue event already exists
    const exists = await checkRevenueEventExists(dealId, serviceId, collectionDate, 'monthly');
    if (exists) {
      // Get the existing event ID
      if (USE_LOCAL_DB) {
        const { getLocalDB } = await import('@/lib/db/local-db');
        const db = getLocalDB();
        const collectionDateStr = format(collectionDate, 'yyyy-MM-dd');
        const existing = db.prepare(`
          SELECT id FROM revenue_events 
          WHERE deal_id = ? 
            AND service_id = ? 
            AND collection_date = ? 
            AND billing_type = 'monthly'
        `).get(dealId, serviceId, collectionDateStr) as any;
        if (existing) {
          eventIds.push(existing.id);
        }
      } else {
        const supabase = await createClient();
        const collectionDateStr = format(collectionDate, 'yyyy-MM-dd');
        const { data } = await (supabase
          .from('revenue_events')
          .select('id')
          .eq('deal_id', dealId)
          .eq('service_id', serviceId)
          .eq('collection_date', collectionDateStr)
          .eq('billing_type', 'monthly')
          .limit(1)
          .single() as any);
        if (data) {
          eventIds.push(data.id);
        }
      }
      continue; // Skip creating duplicate
    }
    
    // Use 'scheduled' for future dates, 'invoice' for past/current dates
    const paymentStage = collectionDate <= today ? 'invoice' : 'scheduled';
    const eventId = await createRevenueEvent(
      dealId,
      serviceId,
      bdrId,
      monthlyAmount,
      collectionDate,
      'monthly',
      paymentStage,
      true
    );
    eventIds.push(eventId);
  }

  return eventIds;
}

/**
 * Schedule quarterly recurring revenue events
 */
export async function scheduleQuarterlyRevenueEvents(
  dealId: string,
  serviceId: string,
  bdrId: string,
  quarterlyAmount: number,
  startDate: Date,
  contractQuarters: number
): Promise<string[]> {
  const eventIds: string[] = [];
  const startMonth = startOfMonth(startDate);
  const today = new Date();
  
  // Determine which quarter the start date is in
  const startQuarter = Math.floor(startMonth.getMonth() / 3);
  const startYear = startMonth.getFullYear();

  for (let i = 0; i < contractQuarters; i++) {
    const quarter = (startQuarter + i) % 4;
    const year = startYear + Math.floor((startQuarter + i) / 4);
    
    // Q1 = Jan (month 0), Q2 = Apr (month 3), Q3 = Jul (month 6), Q4 = Oct (month 9)
    const quarterStartMonth = quarter * 3;
    const collectionDate = new Date(year, quarterStartMonth, 1);
    
    // Check if this revenue event already exists
    const exists = await checkRevenueEventExists(dealId, serviceId, collectionDate, 'quarterly');
    if (exists) {
      // Get the existing event ID
      if (USE_LOCAL_DB) {
        const { getLocalDB } = await import('@/lib/db/local-db');
        const db = getLocalDB();
        const collectionDateStr = format(collectionDate, 'yyyy-MM-dd');
        const existing = db.prepare(`
          SELECT id FROM revenue_events 
          WHERE deal_id = ? 
            AND service_id = ? 
            AND collection_date = ? 
            AND billing_type = 'quarterly'
        `).get(dealId, serviceId, collectionDateStr) as any;
        if (existing) {
          eventIds.push(existing.id);
        }
      } else {
        const supabase = await createClient();
        const collectionDateStr = format(collectionDate, 'yyyy-MM-dd');
        const { data } = await (supabase
          .from('revenue_events')
          .select('id')
          .eq('deal_id', dealId)
          .eq('service_id', serviceId)
          .eq('collection_date', collectionDateStr)
          .eq('billing_type', 'quarterly')
          .limit(1)
          .single() as any);
        if (data) {
          eventIds.push(data.id);
        }
      }
      continue; // Skip creating duplicate
    }
    
    // Use 'scheduled' for future dates, 'invoice' for past/current dates
    const paymentStage = collectionDate <= today ? 'invoice' : 'scheduled';

    const eventId = await createRevenueEvent(
      dealId,
      serviceId,
      bdrId,
      quarterlyAmount,
      collectionDate,
      'quarterly',
      paymentStage,
      true
    );
    eventIds.push(eventId);
  }

  return eventIds;
}

/**
 * Handle renewal uplift - create revenue event for uplift amount only
 */
export async function handleRenewalUplift(
  dealId: string,
  bdrId: string,
  newAmount: number,
  originalAmount: number,
  collectionDate: Date,
  billingType: 'monthly' | 'quarterly' | 'one_off' = 'one_off'
): Promise<string | null> {
  const uplift = newAmount - originalAmount;
  
  if (uplift <= 0) {
    return null; // No commission on non-uplift renewals
  }

  const eventId = await createRevenueEvent(
    dealId,
    null, // Renewal events don't have a specific service
    bdrId,
    uplift,
    collectionDate,
    'renewal',
    'renewal',
    true
  );

  return eventId;
}

/**
 * Create revenue events for a service based on billing type
 */
export async function createRevenueEventsForService(
  dealId: string,
  service: DealService,
  bdrId: string,
  invoiceDate: Date
): Promise<string[]> {
  const eventIds: string[] = [];

  // Check if revenue events already exist for this service
  let existingEventIds: string[] = [];
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();
    const existing = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ? AND service_id = ?').all(dealId, service.id) as any[];
    existingEventIds = existing.map(e => e.id);
  } else {
    const supabase = await createClient();
    const { data } = await (supabase
      .from('revenue_events')
      .select('id')
      .eq('deal_id', dealId)
      .eq('service_id', service.id) as any);
    if (data) {
      existingEventIds = data.map((e: any) => e.id);
    }
  }

  // If events already exist, return their IDs and process them
  if (existingEventIds.length > 0) {
    // Process existing events to ensure commission entries exist
    await Promise.all(existingEventIds.map(id => 
      processRevenueEvent(id).catch(err => {
        console.error(`Error processing existing event ${id}:`, err);
      })));
    return existingEventIds;
  }

  switch (service.billing_type) {
    case 'one_off': {
      // Check if one-off event already exists
      const exists = await checkRevenueEventExists(dealId, service.id, invoiceDate, 'one_off');
      if (exists) {
        // Get existing event ID
        if (USE_LOCAL_DB) {
          const { getLocalDB } = await import('@/lib/db/local-db');
          const db = getLocalDB();
          const collectionDateStr = format(invoiceDate, 'yyyy-MM-dd');
          const existing = db.prepare(`
            SELECT id FROM revenue_events 
            WHERE deal_id = ? 
              AND service_id = ? 
              AND collection_date = ? 
              AND billing_type = 'one_off'
          `).get(dealId, service.id, collectionDateStr) as any;
          if (existing) {
            eventIds.push(existing.id);
            await processRevenueEvent(existing.id).catch(err => {
              console.error(`Error processing one-off event ${existing.id}:`, err);
            });
            return eventIds;
          }
        } else {
          const supabase = await createClient();
          const collectionDateStr = format(invoiceDate, 'yyyy-MM-dd');
          const { data } = await (supabase
            .from('revenue_events')
            .select('id')
            .eq('deal_id', dealId)
            .eq('service_id', service.id)
            .eq('collection_date', collectionDateStr)
            .eq('billing_type', 'one_off')
            .limit(1)
            .single() as any);
          if (data) {
            eventIds.push(data.id);
            await processRevenueEvent(data.id).catch(err => {
              console.error(`Error processing one-off event ${data.id}:`, err);
            });
            return eventIds;
          }
        }
      }
      
      // Single revenue event when payment collected
      const oneOffId = await createRevenueEvent(
        dealId,
        service.id,
        bdrId,
        service.unit_price * service.quantity,
        invoiceDate,
        'one_off',
        'invoice',
        true
      );
      eventIds.push(oneOffId);
      // Process immediately for planning and prediction
      await processRevenueEvent(oneOffId).catch(err => {
        console.error(`Error processing one-off event ${oneOffId}:`, err);
      });
      break;
    }

    case 'deposit': {
      // Check if deposit events already exist
      const completionDate = service.completion_date ? parseISO(service.completion_date) : null;
      const secondPaymentDate = completionDate || addDays(invoiceDate, 60);
      
      const invoiceEventExists = await checkRevenueEventExists(dealId, service.id, invoiceDate, 'one_off');
      const completionEventExists = await checkRevenueEventExists(dealId, service.id, secondPaymentDate, 'one_off');
      
      if (invoiceEventExists && completionEventExists) {
        // Get existing event IDs
        if (USE_LOCAL_DB) {
          const { getLocalDB } = await import('@/lib/db/local-db');
          const db = getLocalDB();
          const invoiceDateStr = format(invoiceDate, 'yyyy-MM-dd');
          const completionDateStr = format(secondPaymentDate, 'yyyy-MM-dd');
          
          const invoiceEvent = db.prepare(`
            SELECT id FROM revenue_events 
            WHERE deal_id = ? 
              AND service_id = ? 
              AND collection_date = ? 
              AND payment_stage = 'invoice'
          `).get(dealId, service.id, invoiceDateStr) as any;
          
          const completionEvent = db.prepare(`
            SELECT id FROM revenue_events 
            WHERE deal_id = ? 
              AND service_id = ? 
              AND collection_date = ? 
              AND payment_stage = 'completion'
          `).get(dealId, service.id, completionDateStr) as any;
          
          if (invoiceEvent) eventIds.push(invoiceEvent.id);
          if (completionEvent) eventIds.push(completionEvent.id);
        } else {
          const supabase = await createClient();
          const invoiceDateStr = format(invoiceDate, 'yyyy-MM-dd');
          const completionDateStr = format(secondPaymentDate, 'yyyy-MM-dd');
          
          const { data: invoiceData } = await (supabase
            .from('revenue_events')
            .select('id')
            .eq('deal_id', dealId)
            .eq('service_id', service.id)
            .eq('collection_date', invoiceDateStr)
            .eq('payment_stage', 'invoice')
            .limit(1)
            .single() as any);
          
          const { data: completionData } = await (supabase
            .from('revenue_events')
            .select('id')
            .eq('deal_id', dealId)
            .eq('service_id', service.id)
            .eq('collection_date', completionDateStr)
            .eq('payment_stage', 'completion')
            .limit(1)
            .single() as any);
          
          if (invoiceData) eventIds.push(invoiceData.id);
          if (completionData) eventIds.push(completionData.id);
        }
        
        // Process existing events
        await Promise.all(eventIds.map(id => 
          processRevenueEvent(id).catch(err => {
            console.error(`Error processing deposit event ${id}:`, err);
          })));
        return eventIds;
      }
      
      // 50/50 payment structure
      const depositIds = await handle50_50Payment(
        dealId,
        service.id,
        bdrId,
        service.unit_price * service.quantity,
        invoiceDate,
        completionDate
      );
      eventIds.push(...depositIds);
      // Process all deposit events immediately for planning and prediction
      await Promise.all(depositIds.map(id => 
        processRevenueEvent(id).catch(err => {
          console.error(`Error processing deposit event ${id}:`, err);
        })));
      break;
    }

    case 'mrr': {
      // Monthly recurring - schedule all months
      if (!service.monthly_price) {
        throw new Error('Monthly price is required for MRR billing type');
      }
      const monthlyIds = await scheduleMonthlyRevenueEvents(
        dealId,
        service.id,
        bdrId,
        service.monthly_price * service.quantity,
        invoiceDate,
        service.contract_months || 12
      );
      eventIds.push(...monthlyIds);
      
      // Process ALL revenue events immediately (past, present, and future)
      // This creates commission entries for all scheduled months for planning and prediction
      await Promise.all(monthlyIds.map(id => 
        processRevenueEvent(id).catch(err => {
          console.error(`Error processing MRR event ${id}:`, err);
        })));
      break;
    }

    case 'quarterly': {
      // Quarterly recurring - schedule all quarters
      if (!service.quarterly_price) {
        throw new Error('Quarterly price is required for quarterly billing type');
      }
      const quarterlyIds = await scheduleQuarterlyRevenueEvents(
        dealId,
        service.id,
        bdrId,
        service.quarterly_price * service.quantity,
        invoiceDate,
        service.contract_quarters || 4
      );
      eventIds.push(...quarterlyIds);
      
      // Process ALL revenue events immediately (past, present, and future)
      // This creates commission entries for all scheduled quarters for planning and prediction
      await Promise.all(quarterlyIds.map(id => 
        processRevenueEvent(id).catch(err => {
          console.error(`Error processing quarterly event ${id}:`, err);
        })));
      break;
    }
  }

  return eventIds;
}

/**
 * Create revenue events for a deal when it's closed-won
 */
export async function createRevenueEventsForDeal(dealId: string): Promise<void> {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('@/lib/db/local-db');
    const db = getLocalDB();

    const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
    if (!deal) {
      throw new Error('Deal not found');
    }

    // Create revenue events for all deals (unless cancelled) that have first_invoice_date
    // This ensures all deals appear in the commission structure
    if (deal.cancellation_date || !deal.first_invoice_date) {
      return;
    }

    const invoiceDate = parseISO(deal.first_invoice_date);

    // Check if revenue events already exist for this deal
    const existingEvents = db.prepare('SELECT COUNT(*) as count FROM revenue_events WHERE deal_id = ?').get(dealId) as any;
    const hasExistingEvents = existingEvents && existingEvents.count > 0;

    // Get services
    const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(dealId) as any[];

    if (services && services.length > 0) {
      // If events exist, check if all services have events
      if (hasExistingEvents) {
        let allServicesHaveEvents = true;
        for (const service of services) {
          const serviceEvents = db.prepare('SELECT COUNT(*) as count FROM revenue_events WHERE deal_id = ? AND service_id = ?').get(dealId, service.id) as any;
          if (!serviceEvents || serviceEvents.count === 0) {
            allServicesHaveEvents = false;
            break;
          }
        }
        
        // If all services already have events, skip creation
        if (allServicesHaveEvents) {
          // Process existing events to ensure commission entries exist
          const allEventIds = db.prepare('SELECT id FROM revenue_events WHERE deal_id = ?').all(dealId) as any[];
          await Promise.all(allEventIds.map((e: any) => 
            processRevenueEvent(e.id).catch(err => {
              console.error(`Error processing existing event ${e.id}:`, err);
            })));
          return;
        }
      }
      // Handle renewal deals
      if (deal.is_renewal) {
        // Calculate uplift for each service or total
        let originalTotal = 0;
        let newTotal = 0;

        if (deal.original_deal_value !== null) {
          originalTotal = deal.original_deal_value;
          newTotal = services.reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
        } else if (deal.original_deal_id) {
          const originalDeal = db.prepare('SELECT * FROM deals WHERE id = ?').get(deal.original_deal_id) as any;
          if (originalDeal) {
            const originalServices = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(deal.original_deal_id) as any[];
            originalTotal = originalServices.reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
            newTotal = services.reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
          }
        }

        if (newTotal > originalTotal) {
          await handleRenewalUplift(
            dealId,
            deal.bdr_id,
            newTotal,
            originalTotal,
            invoiceDate,
            'one_off'
          );
        }
      } else {
        // Regular deal - create events for each service
        for (const service of services) {
          await createRevenueEventsForService(
            dealId,
            service,
            deal.bdr_id,
            invoiceDate
          );
        }
      }
    } else {
      // Legacy deal without services - check if event already exists
      const legacyEventExists = await checkRevenueEventExists(dealId, null, invoiceDate, 'one_off');
      if (legacyEventExists) {
        // Get existing event ID
        const existing = db.prepare(`
          SELECT id FROM revenue_events 
          WHERE deal_id = ? 
            AND service_id IS NULL 
            AND collection_date = ? 
            AND billing_type = 'one_off'
        `).get(dealId, format(invoiceDate, 'yyyy-MM-dd')) as any;
        if (existing) {
          await processRevenueEvent(existing.id).catch(err => {
            console.error(`Error processing legacy event ${existing.id}:`, err);
          });
        }
        return;
      }
      
      // Legacy deal without services - create single revenue event
      const legacyEventId = await createRevenueEvent(
        dealId,
        null,
        deal.bdr_id,
        deal.deal_value,
        invoiceDate,
        'one_off',
        'invoice',
        true
      );
      // Process immediately for planning and prediction
      await processRevenueEvent(legacyEventId).catch(err => {
        console.error(`Error processing legacy event ${legacyEventId}:`, err);
      });
    }
  } else {
    // Supabase mode
    const supabase = await createClient();

    const { data: deal, error: dealError } = await (supabase
      .from('deals')
      .select('*, deal_services(*)')
      .eq('id', dealId)
      .single() as any);

    if (dealError || !deal) {
      throw new Error(`Deal not found: ${dealError?.message}`);
    }

    // Create revenue events for all deals (unless cancelled) that have first_invoice_date
    // This ensures all deals appear in the commission structure
    if (deal.cancellation_date || !deal.first_invoice_date) {
      return;
    }

    const invoiceDate = parseISO(deal.first_invoice_date);
    
    // Check if revenue events already exist for this deal
    const eventsQuery = (supabase as any)
      .from('revenue_events')
      .select('id')
      .eq('deal_id', dealId)
      .limit(1);
    const { data: existingEventsData } = (await eventsQuery) as { data: any[] | null; error: any };
    const hasExistingEvents = existingEventsData && existingEventsData.length > 0;
    
    const services = (deal as any).deal_services as DealService[] | undefined;

    if (services && services.length > 0) {
      // If events exist, check if all services have events
      if (hasExistingEvents) {
        let allServicesHaveEvents = true;
        for (const service of services) {
          const serviceEventsQuery = (supabase as any)
            .from('revenue_events')
            .select('id')
            .eq('deal_id', dealId)
            .eq('service_id', service.id)
            .limit(1);
          const { data: serviceEventsData } = (await serviceEventsQuery) as { data: any[] | null; error: any };
          if (!serviceEventsData || serviceEventsData.length === 0) {
            allServicesHaveEvents = false;
            break;
          }
        }
        
        // If all services already have events, skip creation
        if (allServicesHaveEvents) {
          // Process existing events to ensure commission entries exist
          const allEventsQuery = (supabase as any)
            .from('revenue_events')
            .select('id')
            .eq('deal_id', dealId);
          const { data: allEventIds } = (await allEventsQuery) as { data: any[] | null; error: any };
          if (allEventIds) {
            await Promise.all(allEventIds.map((e: any) => 
              processRevenueEvent(e.id).catch(err => {
                console.error(`Error processing existing event ${e.id}:`, err);
              })));
          }
          return;
        }
      }
      if (deal.is_renewal) {
        // Handle renewal uplift
        let originalTotal = 0;
        let newTotal = 0;

        if ((deal as any).original_deal_value !== null) {
          originalTotal = (deal as any).original_deal_value;
          newTotal = services.reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
        } else if (deal.original_deal_id) {
          const { data: originalDeal } = await (supabase
            .from('deals')
            .select('*, deal_services(*)')
            .eq('id', deal.original_deal_id)
            .single() as any);

          if (originalDeal) {
            const originalServices = (originalDeal as any).deal_services as DealService[] | undefined;
            originalTotal = (originalServices || []).reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
            newTotal = services.reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
          }
        }

        if (newTotal > originalTotal) {
          await handleRenewalUplift(
            dealId,
            deal.bdr_id,
            newTotal,
            originalTotal,
            invoiceDate,
            'one_off'
          );
        }
      } else {
        // Regular deal
        for (const service of services) {
          await createRevenueEventsForService(
            dealId,
            service,
            deal.bdr_id,
            invoiceDate
          );
        }
      }
    } else {
      // Legacy deal without services - check if event already exists
      const legacyEventExists = await checkRevenueEventExists(dealId, null, invoiceDate, 'one_off');
      if (legacyEventExists) {
        // Get existing event ID
        const collectionDateStr = format(invoiceDate, 'yyyy-MM-dd');
        const { data } = await ((supabase as any)
          .from('revenue_events')
          .select('id')
          .eq('deal_id', dealId)
          .is('service_id', null)
          .eq('collection_date', collectionDateStr)
          .eq('billing_type', 'one_off')
          .limit(1)
          .single() as any);
        if (data) {
          await processRevenueEvent(data.id).catch(err => {
            console.error(`Error processing legacy event ${data.id}:`, err);
          });
        }
        return;
      }
      
      // Legacy deal without services - create single revenue event
      const legacyEventId = await createRevenueEvent(
        dealId,
        null,
        deal.bdr_id,
        deal.deal_value,
        invoiceDate,
        'one_off',
        'invoice',
        true
      );
      // Process immediately for planning and prediction
      await processRevenueEvent(legacyEventId).catch(err => {
        console.error(`Error processing legacy event ${legacyEventId}:`, err);
      });
    }
  }
}

