import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export interface ServiceVerification {
  serviceId: string;
  serviceName: string;
  billingType: string;
  expectedCommission: number; // From revenue_events.amount_collected * applicable rate
  accruedCommission: number; // Sum of commission_entries for this service's revenue events
  pendingCommission: number; // Future revenue events not yet processed
  expectedEntryCount: number; // Expected number of commission entries for this billing type
  actualEntryCount: number; // Actual commission entries for this service
  revenueEvents: {
    id: string;
    amountCollected: number;
    collectionDate: string;
    paymentStage: string;
    hasCommissionEntry: boolean;
    commissionAmount: number | null;
  }[];
  status: 'ok' | 'pending' | 'mismatch' | 'missing_entries' | 'wrong_count';
  message: string;
}

export interface DealVerification {
  dealId: string;
  clientName: string;
  closeDate: string;
  expectedTotal: number;
  accruedTotal: number;
  pendingTotal: number;
  services: ServiceVerification[];
  status: 'ok' | 'pending' | 'mismatch' | 'missing_entries' | 'wrong_count';
  message: string;
  hasOverride: boolean;
}

/**
 * Verify that commission entries match expected amounts for each deal/service.
 * Compares deal_services.commission_amount vs sum of commission_entries per service.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth();

    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');
    const dealId = searchParams.get('deal_id');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      let targetBdrId = bdrId;
      if (!isUserAdmin) {
        const userBdrId = await getBdrIdFromUser();
        if (!userBdrId) {
          return apiError('BDR profile not found', 404);
        }
        targetBdrId = userBdrId;
      }

      const rules = db.prepare('SELECT base_rate FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as { base_rate: number } | undefined;
      const defaultRate = rules?.base_rate ?? 0.025;
      const today = new Date().toISOString().split('T')[0];

      let dealsQuery = `
        SELECT d.id, d.client_name, d.close_date, d.bdr_id
        FROM deals d
        WHERE d.status = 'closed-won' 
          AND d.cancellation_date IS NULL
          AND d.first_invoice_date IS NOT NULL
      `;
      const params: (string | number)[] = [];
      if (targetBdrId) {
        dealsQuery += ' AND d.bdr_id = ?';
        params.push(targetBdrId);
      }
      if (dealId) {
        dealsQuery += ' AND d.id = ?';
        params.push(dealId);
      }
      dealsQuery += ' ORDER BY d.close_date';

      const deals = db.prepare(dealsQuery).all(...params) as Array<{ id: string; client_name: string; close_date: string; bdr_id: string }>;

      const dealVerifications: DealVerification[] = [];
      let allOk = true;

      for (const deal of deals) {
        const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(deal.id) as any[];

        const serviceVerifications: ServiceVerification[] = [];
        let dealExpected = 0;
        let dealAccrued = 0;
        let dealPending = 0;
        let dealStatus: DealVerification['status'] = 'ok';
        let dealMessage = '';

        for (const service of services) {
          // Expected commission entry count by billing type
          let expectedEntryCount: number;
          const billingType = (service.billing_type || '').toLowerCase();
          if (billingType === 'deposit') {
            expectedEntryCount = service.completion_date ? 2 : 1; // First 50% + second 50% if completion_date set
          } else if (billingType === 'one_off' || billingType === 'renewal' || billingType === 'paid_on_completion') {
            expectedEntryCount = 1;
          } else if (billingType === 'mrr') {
            expectedEntryCount = service.contract_months ?? 12;
          } else if (billingType === 'quarterly') {
            expectedEntryCount = service.contract_quarters ?? 4;
          } else {
            expectedEntryCount = 1;
          }

          const revenueEvents = db.prepare(`
            SELECT re.id, re.amount_collected, re.collection_date, re.payment_stage, re.billing_type
            FROM revenue_events re
            WHERE re.deal_id = ? AND re.service_id = ? AND re.commissionable = 1
            ORDER BY re.collection_date
          `).all(deal.id, service.id) as Array<{ id: string; amount_collected: number; collection_date: string; payment_stage: string; billing_type: string }>;

          // Renewal exception: one-time uplift commission, due 7 days after close (1 entry only)
          const isRenewal = service.is_renewal === 1 || service.is_renewal === true ||
            revenueEvents.some((re: { billing_type?: string }) => re.billing_type === 'renewal');
          if (isRenewal) {
            expectedEntryCount = 1;
          }

          let accruedCommission = 0;
          let pendingCommission = 0;
          let expectedCommission = 0;
          const eventDetails: ServiceVerification['revenueEvents'] = [];

          for (const re of revenueEvents) {
            const ce = db.prepare('SELECT id, amount FROM commission_entries WHERE revenue_event_id = ?').get(re.id) as { id: string; amount: number } | undefined;
            const hasEntry = !!ce;
            const commissionAmount = ce ? Number(ce.amount) : null;
            const rate = service.commission_rate ?? defaultRate;
            const expectedForEvent = re.amount_collected * rate;
            expectedCommission += expectedForEvent;

            if (hasEntry) {
              accruedCommission += Number(ce!.amount);
            } else if (re.collection_date <= today) {
              // Past due but no commission entry - missing!
              pendingCommission += expectedForEvent;
            } else {
              // Future - not yet due
              pendingCommission += expectedForEvent;
            }

            eventDetails.push({
              id: re.id,
              amountCollected: re.amount_collected,
              collectionDate: re.collection_date,
              paymentStage: re.payment_stage,
              hasCommissionEntry: hasEntry,
              commissionAmount,
            });
          }

          dealExpected += expectedCommission;
          dealAccrued += accruedCommission;
          dealPending += pendingCommission;

          const actualEntryCount = revenueEvents.filter(re => {
            const ce = db.prepare('SELECT 1 FROM commission_entries WHERE revenue_event_id = ?').get(re.id);
            return !!ce;
          }).length;

          let status: ServiceVerification['status'] = 'ok';
          let message = '';

          const total = accruedCommission + pendingCommission;
          const diff = Math.abs(total - expectedCommission);

          const hasWrongCount = actualEntryCount !== expectedEntryCount;

          const hasMissingPast = revenueEvents.some(re => {
            const ce = db.prepare('SELECT 1 FROM commission_entries WHERE revenue_event_id = ?').get(re.id);
            return re.collection_date <= today && !ce;
          });
          if (hasWrongCount) {
            status = 'wrong_count';
            message = `Expected ${expectedEntryCount} entries, got ${actualEntryCount} - run Reprocess`;
            dealStatus = 'wrong_count';
            allOk = false;
          } else if (hasMissingPast) {
            status = 'missing_entries';
            message = `Some collected revenue (collection_date <= today) has no commission entry - run Reprocess`;
            dealStatus = 'missing_entries';
            allOk = false;
          } else if (diff > 0.02) {
            status = 'mismatch';
            message = `Expected $${expectedCommission.toFixed(2)}, got $${accruedCommission.toFixed(2)} accrued + $${pendingCommission.toFixed(2)} pending`;
            dealStatus = 'mismatch';
            allOk = false;
          } else if (pendingCommission > 0) {
            status = 'pending';
            message = `${actualEntryCount}/${expectedEntryCount} entries · $${accruedCommission.toFixed(2)} accrued, $${pendingCommission.toFixed(2)} pending`;
          } else {
            message = `${actualEntryCount}/${expectedEntryCount} entries · $${accruedCommission.toFixed(2)} accrued`;
          }

          serviceVerifications.push({
            serviceId: service.id,
            serviceName: service.service_name,
            billingType: service.billing_type,
            expectedCommission,
            accruedCommission,
            pendingCommission,
            expectedEntryCount,
            actualEntryCount,
            revenueEvents: eventDetails,
            status,
            message,
          });
        }

        if (dealStatus === 'ok' && dealPending > 0) {
          dealMessage = `${dealAccrued.toFixed(2)} accrued, ${dealPending.toFixed(2)} pending`;
        } else if (dealStatus === 'wrong_count') {
          dealMessage = 'Incorrect number of commission entries for one or more services';
        } else if (dealStatus === 'missing_entries') {
          dealMessage = 'Some revenue events missing commission entries';
        } else if (dealStatus === 'mismatch') {
          dealMessage = `Expected ${dealExpected.toFixed(2)}, accrued ${dealAccrued.toFixed(2)}, pending ${dealPending.toFixed(2)}`;
        }

        const hasOverride = !!(db.prepare(`
          SELECT 1 FROM commission_entries ce
          JOIN commission_batch_items cbi ON cbi.commission_entry_id = ce.id
          WHERE ce.deal_id = ?
            AND (cbi.override_amount IS NOT NULL
                 OR cbi.override_payment_date IS NOT NULL
                 OR cbi.override_commission_rate IS NOT NULL)
          LIMIT 1
        `).get(deal.id));

        dealVerifications.push({
          dealId: deal.id,
          clientName: deal.client_name,
          closeDate: deal.close_date,
          expectedTotal: dealExpected,
          accruedTotal: dealAccrued,
          pendingTotal: dealPending,
          services: serviceVerifications,
          status: dealStatus,
          message: dealMessage,
          hasOverride,
        });
      }

      return apiSuccess({
        deals: dealVerifications,
        summary: {
          totalDeals: dealVerifications.length,
          allVerified: allOk,
          withIssues: dealVerifications.filter(d => !['ok', 'pending'].includes(d.status)).length,
        },
      }, 200, { cache: 'no-store' });
    }

    return apiError('Verification only supported for local DB', 501);
  } catch (error: any) {
    return apiError(error.message || 'Verification failed', 401);
  }
}
