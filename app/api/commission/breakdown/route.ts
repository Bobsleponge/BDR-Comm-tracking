import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Get commission breakdown by month with deal/service details
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');
    const serviceType = searchParams.get('service_type');
    const billingType = searchParams.get('billing_type');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Determine which BDR to query
      let targetBdrId = bdrId;
      if (!isUserAdmin) {
        const userBdrId = await getBdrIdFromUser();
        if (!userBdrId) {
          return apiError('BDR profile not found', 404);
        }
        targetBdrId = userBdrId;
      }

      // Build query to get commission entries with all related data
      // Only show actual commission entries - no forecasted/scheduled payments
      const params: any[] = [];
      
      let query = `
        SELECT 
          ce.id,
          ce.bdr_id,
          ce.deal_id as ce_deal_id,
          ce.revenue_event_id as revenue_event_id,
          ce.amount,
          ce.status,
          ce.accrual_date,
          ce.payable_date,
          ce.month,
          d.id as deal_id,
          d.client_name,
          d.close_date,
          d.service_type as deal_service_type,
          d.deal_value,
          d.original_deal_value,
          d.is_renewal as deal_is_renewal,
          ds.id as service_id,
          ds.service_name,
          ds.billing_type,
          ds.original_service_value,
          ds.commissionable_value,
          ds.is_renewal as service_is_renewal,
          re.deal_id as re_deal_id,
          re.amount_collected,
          re.collection_date,
          re.payment_stage,
          re.billing_type as revenue_billing_type,
          'commission_entry' as source_type
        FROM commission_entries ce
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        INNER JOIN deals d ON d.id = COALESCE(re.deal_id, ce.deal_id)
        LEFT JOIN deal_services ds ON re.service_id = ds.id
        WHERE d.cancellation_date IS NULL
          AND ce.status != 'cancelled'
      `;

      if (targetBdrId) {
        query += ' AND ce.bdr_id = ?';
        params.push(targetBdrId);
      }

      if (serviceType) {
        query += ' AND d.service_type = ?';
        params.push(serviceType);
      }

      if (billingType) {
        query += ' AND (ds.billing_type = ? OR re.billing_type = ?)';
        params.push(billingType, billingType);
      }

      query += ` ORDER BY accrual_date ASC, payable_date ASC LIMIT 5000`;

      const entries = db.prepare(query).all(...params) as any[];

      // Determine which entries are approved (in paid reports via fingerprints)
      const fingerprints = db.prepare('SELECT bdr_id, deal_id, effective_date FROM approved_commission_fingerprints').all() as Array<{ bdr_id: string; deal_id: string; effective_date: string }>;
      const fpSet = new Set(fingerprints.map(f => `${f.bdr_id}|${f.deal_id}|${f.effective_date}`));
      const getEffectiveDate = (e: any) => e.payable_date || e.accrual_date || (e.month ? `${e.month}-01` : null);

      // Fallback: for entries with no service (no revenue_event or re.service_id null), get first service per deal
      const dealIdsNeedingService = [...new Set(entries.filter((e) => !e.service_id && e.deal_id).map((e) => e.deal_id))];
      const fallbackServices = new Map<string, { id: string; name: string; billing_type: string }>();
      if (dealIdsNeedingService.length > 0) {
        const placeholders = dealIdsNeedingService.map(() => '?').join(',');
        const fallbackRows = db.prepare(`
          SELECT id, deal_id, service_name, billing_type FROM deal_services
          WHERE deal_id IN (${placeholders}) ORDER BY deal_id, service_name
        `).all(...dealIdsNeedingService) as Array<{ id: string; deal_id: string; service_name: string; billing_type: string }>;
        fallbackRows.forEach((r) => {
          if (!fallbackServices.has(r.deal_id)) fallbackServices.set(r.deal_id, { id: r.id, name: r.service_name, billing_type: r.billing_type });
        });
      }

      // Group by payable month (when BDR can claim commission)
      const breakdownByMonth = new Map<string, {
        month: string;
        totalAmount: number;
        entries: any[];
      }>();

      entries.forEach(entry => {
        // paid_on_completion: always use payable_date (commission due 7 days after completion)
        // Other types: payable_date first, then accrual_date, then month
        const billingType = entry.billing_type ?? entry.revenue_billing_type;
        const isPaidOnCompletion = billingType === 'paid_on_completion';
        const payableMonth = (isPaidOnCompletion && entry.payable_date)
          ? entry.payable_date.substring(0, 7)
          : entry.payable_date
            ? entry.payable_date.substring(0, 7)
            : entry.accrual_date
              ? entry.accrual_date.substring(0, 7)
              : entry.month
                ? (typeof entry.month === 'string' ? entry.month.substring(0, 7) : entry.month)
                : 'unknown';

        if (!breakdownByMonth.has(payableMonth)) {
          breakdownByMonth.set(payableMonth, {
            month: payableMonth,
            totalAmount: 0,
            entries: [],
          });
        }

        const monthData = breakdownByMonth.get(payableMonth)!;
        monthData.totalAmount += Number(entry.amount);
        const serviceIsRenewal = entry.service_id && (entry.service_is_renewal === 1 || entry.service_is_renewal === true);
        const dealIsRenewal = entry.deal_is_renewal === 1 || entry.deal_is_renewal === true;
        const isRenewal = serviceIsRenewal || dealIsRenewal || entry.revenue_billing_type === 'renewal';
        let previousDealAmount = 0;
        let newDealAmount = 0;
        if (isRenewal) {
          if (entry.service_id && (entry.original_service_value != null || entry.commissionable_value != null)) {
            previousDealAmount = Number(entry.original_service_value ?? 0);
            newDealAmount = Number(entry.commissionable_value ?? 0);
          } else {
            previousDealAmount = Number(entry.original_deal_value ?? 0);
            newDealAmount = Number(entry.deal_value ?? 0);
          }
        }
        const derivedUplift = isRenewal && newDealAmount > previousDealAmount ? newDealAmount - previousDealAmount : 0;
        const displayAmountCollected =
          isRenewal && derivedUplift > 0
            ? derivedUplift
            : Number(entry.amount_collected ?? 0);
        const effectiveDate = getEffectiveDate(entry);
        const isApproved = effectiveDate && fpSet.has(`${entry.bdr_id}|${entry.ce_deal_id}|${effectiveDate}`);
        // Generate unique ID: use commission entry ID if available, otherwise use revenue_event_id for scheduled entries
        const uniqueId = entry.id || (entry.revenue_event_id ? `scheduled-${entry.revenue_event_id}` : `scheduled-${entry.deal_id}-${entry.collection_date}`);
        monthData.entries.push({
          id: uniqueId,
          amount: Number(entry.amount),
          status: entry.status || (entry.source_type === 'scheduled_revenue' ? 'scheduled' : entry.status),
          isApproved,
          accrualDate: entry.accrual_date,
          payableDate: entry.payable_date,
          previousDealAmount: isRenewal ? previousDealAmount : null,
          newDealAmount: isRenewal ? newDealAmount : null,
          deal: {
            id: entry.deal_id,
            clientName: entry.client_name,
            serviceType: entry.deal_service_type,
            closeDate: entry.close_date || null,
          },
          service: (() => {
            if (entry.service_id) return { id: entry.service_id, name: entry.service_name, billingType: entry.billing_type };
            const fb = fallbackServices.get(entry.deal_id);
            return fb ? { id: fb.id, name: fb.name, billingType: fb.billing_type } : null;
          })(),
          revenueEvent: displayAmountCollected > 0 || entry.collection_date ? {
            amountCollected: displayAmountCollected,
            collectionDate: entry.collection_date,
            paymentStage: entry.payment_stage,
            billingType: entry.revenue_billing_type || entry.billing_type,
          } : null,
        });
      });

      // Convert to array and sort by month
      const breakdown = Array.from(breakdownByMonth.values())
        .sort((a, b) => a.month.localeCompare(b.month));

      // #region agent log
      const sampleEntries = breakdown.flatMap((m) => m.entries).slice(0, 8).map((e) => ({
        dealId: e.deal?.id,
        clientName: e.deal?.clientName,
        serviceType: e.deal?.serviceType,
        serviceName: e.service?.name,
        serviceBilling: e.service?.billingType,
      }));
      const rawSample = entries.slice(0, 8).map((e) => ({
        ce_id: e.id,
        ce_deal_id: e.deal_id,
        re_deal_id: e.re_deal_id,
        deal_mismatch: e.re_deal_id && e.re_deal_id !== e.deal_id,
        client_name: e.client_name,
        deal_service_type: e.deal_service_type,
        service_id: e.service_id,
        service_name: e.service_name,
      }));
      const dealIds = [...new Set([
        ...entries.filter((e) => e.re_deal_id).slice(0, 3).map((e) => e.re_deal_id),
        ...entries.filter((e) => e.deal_id).slice(0, 3).map((e) => e.deal_id),
      ])];
      const dealInfoSample = dealIds.length > 0
        ? db.prepare(`SELECT id, client_name, service_type FROM deals WHERE id IN (${dealIds.map(() => '?').join(',')})`).all(...dealIds) as any[]
        : [];
      fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'breakdown/route.ts:local',message:'Breakdown sample',data:{sampleEntries,rawSample,dealInfoSample,totalEntries:entries.length},timestamp:Date.now(),hypothesisId:'breakdown'})}).catch(()=>{});
      // #endregion

      return apiSuccess({
        breakdown,
        total: entries.reduce((sum, e) => sum + Number(e.amount), 0),
        entryCount: entries.length,
      }, 200, { cache: 'no-store' }); // No cache to ensure fresh data
    }

    // Supabase mode
    const supabase = await createClient();

    // Determine which BDR to query
    let targetBdrId = bdrId;
    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      targetBdrId = userBdrId;
    }

    // Build query
    let query: any = (supabase as any)
      .from('commission_entries')
      .select(`
        id,
        bdr_id,
        deal_id,
        amount,
        status,
        accrual_date,
        payable_date,
        month,
        deals!inner(id, client_name, service_type, close_date, cancellation_date, deal_value, original_deal_value, is_renewal),
        revenue_events(
          id,
          amount_collected,
          collection_date,
          payment_stage,
          billing_type,
          deal_services(id, service_name, billing_type, original_service_value, commissionable_value, is_renewal)
        )
      `)
      .is('deals.cancellation_date', null)
      .neq('status', 'cancelled')
      .order('accrual_date', { ascending: true, nullsFirst: false })
      .order('payable_date', { ascending: true, nullsFirst: false });

    if (targetBdrId) {
      query = query.eq('bdr_id', targetBdrId);
    }

    if (serviceType) {
      query = query.eq('deals.service_type', serviceType);
    }

    const { data: entries, error } = (await query) as { data: any[] | null; error: any };

    if (error) {
      return apiError(error.message || 'Failed to fetch commission breakdown', 500);
    }

    // Filter by billing type if specified
    let filteredEntries = entries || [];

    if (billingType) {
      filteredEntries = filteredEntries.filter((entry: any) => {
        const revenueEvent = entry.revenue_events;
        if (revenueEvent) {
          return revenueEvent.billing_type === billingType ||
                 revenueEvent.deal_services?.billing_type === billingType;
        }
        return false;
      });
    }

    // Approved commission fingerprints (same logic as local DB / entries API)
    const bdrIdsForFp = [...new Set((filteredEntries as any[]).map((e: any) => e.bdr_id).filter(Boolean))];
    let fpSet = new Set<string>();
    if (bdrIdsForFp.length > 0) {
      const { data: fpRows } = await supabase
        .from('approved_commission_fingerprints')
        .select('bdr_id, deal_id, effective_date')
        .in('bdr_id', bdrIdsForFp);
      fpSet = new Set((fpRows || []).map((f: any) => `${f.bdr_id}|${f.deal_id}|${f.effective_date}`));
    }
    const getEffectiveDate = (e: any) => e.payable_date || e.accrual_date || (e.month ? `${e.month}-01` : null);

    // Fallback: for entries with no service, fetch first service per deal
    const dealIdsNeedingService = [...new Set(
      filteredEntries
        .filter((e: any) => !e.revenue_events?.deal_services && e.deals?.id)
        .map((e: any) => e.deals.id)
    )];
    const fallbackServicesSupabase = new Map<string, { id: string; name: string; billing_type: string }>();
    if (dealIdsNeedingService.length > 0) {
      const { data: dsRows } = await supabase
        .from('deal_services')
        .select('id, deal_id, service_name, billing_type')
        .in('deal_id', dealIdsNeedingService)
        .order('service_name', { ascending: true });
      (dsRows || []).forEach((r: any) => {
        if (!fallbackServicesSupabase.has(r.deal_id)) {
          fallbackServicesSupabase.set(r.deal_id, { id: r.id, name: r.service_name, billing_type: r.billing_type });
        }
      });
    }

    // Group by payable month (when BDR can claim commission)
    // This ensures commission appears in the month the BDR can actually claim it
    const breakdownByMonth = new Map<string, {
      month: string;
      totalAmount: number;
      entries: any[];
    }>();

    filteredEntries.forEach((entry: any) => {
      // paid_on_completion: always use payable_date (commission due 7 days after completion)
      const entryBillingType = entry.revenue_events?.deal_services?.billing_type ?? entry.revenue_events?.billing_type;
      const isPaidOnCompletion = entryBillingType === 'paid_on_completion';
      const payableMonth = (isPaidOnCompletion && entry.payable_date)
        ? entry.payable_date.substring(0, 7)
        : entry.payable_date
          ? entry.payable_date.substring(0, 7)
          : entry.accrual_date
            ? entry.accrual_date.substring(0, 7)
            : entry.month
              ? (typeof entry.month === 'string' ? entry.month.substring(0, 7) : entry.month)
              : 'unknown';

      if (!breakdownByMonth.has(payableMonth)) {
        breakdownByMonth.set(payableMonth, {
          month: payableMonth,
          totalAmount: 0,
          entries: [],
        });
      }

      const monthData = breakdownByMonth.get(payableMonth)!;
      monthData.totalAmount += Number(entry.amount);

      const revenueEvent = entry.revenue_events;
      const dealService = revenueEvent?.deal_services;
      const dsObj = Array.isArray(dealService) ? dealService[0] : dealService;
      const serviceIsRenewal = dsObj?.is_renewal === true;
      const dealIsRenewal = entry.deals?.is_renewal || false;
      const isRenewal = serviceIsRenewal || dealIsRenewal || revenueEvent?.billing_type === 'renewal';
      let previousDealAmount: number | null = null;
      let newDealAmount: number | null = null;
      if (isRenewal) {
        if (dsObj && (dsObj.original_service_value != null || dsObj.commissionable_value != null)) {
          previousDealAmount = Number(dsObj.original_service_value ?? 0);
          newDealAmount = Number(dsObj.commissionable_value ?? 0);
        } else {
          previousDealAmount = Number(entry.deals?.original_deal_value ?? 0);
          newDealAmount = Number(entry.deals?.deal_value ?? 0);
        }
      }
      const derivedUplift = isRenewal && previousDealAmount != null && newDealAmount != null && newDealAmount > previousDealAmount ? newDealAmount - previousDealAmount : 0;
      const displayAmountCollected = isRenewal && derivedUplift > 0 ? derivedUplift : Number(revenueEvent?.amount_collected ?? 0);

      const effectiveDate = getEffectiveDate(entry);
      const isApproved = !!(effectiveDate && fpSet.has(`${entry.bdr_id}|${entry.deal_id}|${effectiveDate}`));

      monthData.entries.push({
        id: entry.id,
        amount: Number(entry.amount),
        status: entry.status,
        isApproved,
        accrualDate: entry.accrual_date,
        payableDate: entry.payable_date,
        previousDealAmount: isRenewal ? previousDealAmount : null,
        newDealAmount: isRenewal ? newDealAmount : null,
        deal: {
          id: entry.deals.id,
          clientName: entry.deals.client_name,
          serviceType: entry.deals.service_type,
          closeDate: entry.deals.close_date || null,
        },
        service: (() => {
          const ds = revenueEvent?.deal_services;
          const dsObjForService = Array.isArray(ds) ? ds?.[0] : ds;
          if (dsObjForService) return { id: dsObjForService.id, name: dsObjForService.service_name, billingType: dsObjForService.billing_type };
          const fb = fallbackServicesSupabase.get(entry.deals?.id);
          return fb ? { id: fb.id, name: fb.name, billingType: fb.billing_type } : null;
        })(),
        revenueEvent: displayAmountCollected > 0 || revenueEvent?.collection_date ? {
          amountCollected: displayAmountCollected,
          collectionDate: revenueEvent?.collection_date,
          paymentStage: revenueEvent?.payment_stage,
          billingType: revenueEvent?.billing_type,
        } : null,
      });
    });

    // Convert to array and sort by month
    const breakdown = Array.from(breakdownByMonth.values())
      .sort((a, b) => a.month.localeCompare(b.month));

    return apiSuccess({
      breakdown,
      total: filteredEntries.reduce((sum: number, e: any) => sum + Number(e.amount), 0),
      entryCount: filteredEntries.length,
    }, 200, { cache: 'no-store' }); // No cache to ensure fresh data
  } catch (error: any) {
    return apiError(error.message || 'Unauthorized', 401);
  }
}

