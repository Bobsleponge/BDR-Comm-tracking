import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth } from '@/lib/utils/api-helpers';
import { generateUUID } from '@/lib/utils/uuid';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * GET /api/commission/batches
 * List batches for current BDR. Admin can filter by bdr_id.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrId = searchParams.get('bdr_id');

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    let targetBdrId = bdrId;
    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      targetBdrId = userBdrId;
    }

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      let query = `
        SELECT 
          cb.id,
          cb.bdr_id,
          cb.run_date,
          cb.status,
          cb.created_at,
          br.name as bdr_name,
          (SELECT COUNT(*) FROM commission_batch_items WHERE batch_id = cb.id) as item_count,
          (SELECT COALESCE(SUM(
            CASE
              WHEN cbi.override_amount IS NOT NULL THEN cbi.override_amount
              WHEN cbi.override_commission_rate IS NOT NULL AND COALESCE(re.amount_collected, 0) > 0
                THEN re.amount_collected * cbi.override_commission_rate
              ELSE COALESCE(ce.amount, 0)
            END
          ), 0)
           FROM commission_batch_items cbi
           JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
           LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
           WHERE cbi.batch_id = cb.id) as total_amount
        FROM commission_batches cb
        LEFT JOIN bdr_reps br ON cb.bdr_id = br.id
        WHERE 1=1
      `;
      const params: any[] = [];
      if (targetBdrId) {
        query += ' AND cb.bdr_id = ?';
        params.push(targetBdrId);
      }
      query += ' ORDER BY cb.run_date DESC, cb.created_at DESC';

      const batches = db.prepare(query).all(...params) as any[];

      // For approved/paid batches with 0 batch_items (e.g. imported from Excel), use snapshot
      const batchesWithTotals = batches.map((b) => {
        let item_count = b.item_count || 0;
        let total_amount = b.total_amount ?? 0;
        if ((b.status === 'approved' || b.status === 'paid') && item_count === 0) {
          const snap = db.prepare('SELECT snapshot_data FROM commission_batch_snapshots WHERE batch_id = ?').get(b.id) as { snapshot_data: string } | undefined;
          if (snap?.snapshot_data) {
            try {
              const rows = JSON.parse(snap.snapshot_data) as Array<{ final_invoiced_amount?: string; original_commission?: string }>;
              item_count = rows.length;
              total_amount = rows.reduce((sum, r) => {
                const amt = parseFloat(String(r.final_invoiced_amount || r.original_commission || '0').replace(/[^0-9.-]/g, '')) || 0;
                return sum + amt;
              }, 0);
            } catch {
              // ignore parse errors
            }
          }
        }
        return {
          id: b.id,
          bdr_id: b.bdr_id,
          bdr_name: b.bdr_name,
          run_date: b.run_date,
          status: b.status,
          created_at: b.created_at,
          item_count,
          total_amount,
        };
      });

      return apiSuccess({
        data: batchesWithTotals,
      }, 200, { cache: 'no-store' });
    }

    // Supabase mode
    const supabase = await createClient();

    let query = supabase
      .from('commission_batches')
      .select(`
        id,
        bdr_id,
        run_date,
        status,
        created_at,
        bdr_reps(name)
      `)
      .order('run_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (targetBdrId) {
      query = query.eq('bdr_id', targetBdrId);
    }

    const { data: batches, error } = await query;

    if (error) {
      return apiError(error.message, 500);
    }

    // Fetch item counts and totals for each batch
    const batchesWithTotals = await Promise.all(
      (batches || []).map(async (batch: any) => {
        const { data: items } = await supabase
          .from('commission_batch_items')
          .select(`
            override_amount,
            override_commission_rate,
            commission_entries(amount, revenue_events(amount_collected))
          `)
          .eq('batch_id', batch.id);

        let totalAmount = 0;
        for (const item of items || []) {
          const entry = item as any;
          const ce = entry.commission_entries;
          const ceObj = Array.isArray(ce) ? ce[0] : ce;
          const re = ceObj?.revenue_events;
          const reObj = Array.isArray(re) ? re[0] : re;
          const collected = Number(reObj?.amount_collected ?? 0);
          let amt: number;
          if (entry.override_amount != null) {
            amt = Number(entry.override_amount);
          } else if (entry.override_commission_rate != null && collected > 0) {
            amt = collected * entry.override_commission_rate;
          } else {
            amt = Number(ceObj?.amount ?? 0);
          }
          totalAmount += amt;
        }

        return {
          id: batch.id,
          bdr_id: batch.bdr_id,
          bdr_name: Array.isArray(batch.bdr_reps) ? batch.bdr_reps[0]?.name : batch.bdr_reps?.name,
          run_date: batch.run_date,
          status: batch.status,
          created_at: batch.created_at,
          item_count: items?.length ?? 0,
          total_amount: totalAmount,
        };
      })
    );

    return apiSuccess({ data: batchesWithTotals }, 200, { cache: 'no-store' });
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission batches list API error:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}

/**
 * POST /api/commission/batches
 * Create a draft batch and attach all eligible entries (Generate Report).
 */
export async function POST(request: NextRequest) {
  try {
    await requireAuth();

    const { getBdrIdFromUser } = await import('@/lib/utils/auth');
    const bdrId = await getBdrIdFromUser();
    if (!bdrId) {
      return apiError('BDR profile not found', 404);
    }

    const today = new Date().toISOString().split('T')[0];

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Eligible = due for payment AND not in any accepted (approved/paid) report
      // 1) commission_batch_items: exclude entry IDs in approved/paid batches
      // 2) approved_commission_fingerprints: survives reprocessing (batch_items CASCADE when entries deleted)
      // Fingerprint match uses month (yyyy-MM) to handle date format differences (e.g. 2026-02-01 vs 2026-02-15)
      const eligible = db.prepare(`
        SELECT ce.id
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        WHERE ce.bdr_id = ?
          AND ce.status IN ('payable', 'accrued', 'pending')
          AND COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01') <= date('now')
          AND (ce.invoiced_batch_id IS NULL OR ce.invoiced_batch_id = '')
          AND NOT EXISTS (
            SELECT 1 FROM commission_batch_items cbi
            JOIN commission_batches cb ON cbi.batch_id = cb.id
            WHERE cbi.commission_entry_id = ce.id AND cb.status IN ('approved', 'paid')
          )
          AND NOT EXISTS (
            SELECT 1 FROM approved_commission_fingerprints acf
            WHERE acf.bdr_id = ce.bdr_id AND acf.deal_id = ce.deal_id
              AND substr(acf.effective_date, 1, 7) = substr(COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01'), 1, 7)
          )
          AND d.cancellation_date IS NULL
      `).all(bdrId) as Array<{ id: string }>;

      if (eligible.length === 0) {
        return apiError('No eligible commission entries to include in report', 400);
      }

      const batchId = generateUUID();

      const insertBatch = db.prepare(`
        INSERT INTO commission_batches (id, bdr_id, run_date, status)
        VALUES (?, ?, ?, 'draft')
      `);
      insertBatch.run(batchId, bdrId, today);

      const updateEntry = db.prepare(`
        UPDATE commission_entries SET invoiced_batch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `);
      const insertItem = db.prepare(`
        INSERT INTO commission_batch_items (id, batch_id, commission_entry_id)
        VALUES (?, ?, ?)
      `);

      for (const entry of eligible) {
        updateEntry.run(batchId, entry.id);
        insertItem.run(generateUUID(), batchId, entry.id);
      }

      // Fetch the created batch with items
      const batch = db.prepare('SELECT * FROM commission_batches WHERE id = ?').get(batchId) as any;
      const items = db.prepare(`
        SELECT cbi.*, ce.amount, ce.deal_id, ce.payable_date, ce.accrual_date, ce.month,
               d.client_name, d.service_type,
               ds.service_name, ds.commission_rate, ds.billing_type,
               re.collection_date
        FROM commission_batch_items cbi
        JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
        JOIN deals d ON ce.deal_id = d.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
        WHERE cbi.batch_id = ?
      `).all(batchId) as any[];

      return apiSuccess({
        ...batch,
        items: items.map((i) => ({
          id: i.id,
          commission_entry_id: i.commission_entry_id,
          override_amount: i.override_amount,
          adjustment_note: i.adjustment_note,
          amount: i.amount,
          client_name: i.client_name,
          service_type: i.service_type,
          service_name: i.service_name,
          commission_rate: i.commission_rate,
          billing_type: i.billing_type,
          collection_date: i.collection_date,
          payable_date: i.payable_date,
          accrual_date: i.accrual_date,
          month: i.month,
        })),
      }, 201, { cache: 'no-store' });
    }

    // Supabase mode: eligible = due for payment, not in any batch (invoiced_batch_id null = not in approved/paid report)
    const supabase = await createClient();

    // Filter by effective date <= today and non-cancelled deals; invoiced_batch_id null excludes entries in any report
    const { data: eligible, error: eligibleError } = await supabase
      .from('commission_entries')
      .select('id')
      .eq('bdr_id', bdrId)
      .in('status', ['payable', 'accrued', 'pending'])
      .is('invoiced_batch_id', null);

    if (eligibleError) {
      return apiError(eligibleError.message, 500);
    }

    // Filter by effective date <= today and non-cancelled deals (include placeholder entries for % of net sales)
    const { data: entriesWithDates } = await supabase
      .from('commission_entries')
      .select('id, payable_date, accrual_date, month, deal_id, deals!inner(cancellation_date)')
      .eq('bdr_id', bdrId)
      .in('status', ['payable', 'accrued', 'pending'])
      .is('invoiced_batch_id', null)
      .is('deals.cancellation_date', null);

    let filteredIds = (entriesWithDates || [])
      .filter((e: any) => {
        if (e.deals?.cancellation_date) return false;
        const effectiveDate = e.payable_date || e.accrual_date || (e.month ? `${e.month}-01` : null);
        return effectiveDate && effectiveDate <= today;
      })
      .map((e: any) => e.id);

    // Exclude entries already in approved/paid reports (source of truth: commission_batch_items)
    const { data: approvedBatches } = await supabase
      .from('commission_batches')
      .select('id')
      .in('status', ['approved', 'paid']);
    const approvedBatchIds = (approvedBatches || []).map((b: any) => b.id);
    let alreadyApprovedIds = new Set<string>();
    if (approvedBatchIds.length > 0) {
      const { data: items } = await supabase
        .from('commission_batch_items')
        .select('commission_entry_id')
        .in('batch_id', approvedBatchIds);
      alreadyApprovedIds = new Set((items || []).map((i: any) => i.commission_entry_id));
    }
    filteredIds = filteredIds.filter((id: string) => !alreadyApprovedIds.has(id));

    // Exclude by approved_commission_fingerprints (survives reprocessing)
    // Match on (deal_id, month yyyy-MM) - if we paid that deal+month, exclude regardless of exact date (handles 2026-02-01 vs 2026-02-15 format differences)
    const { data: fps } = await supabase
      .from('approved_commission_fingerprints')
      .select('deal_id, effective_date')
      .eq('bdr_id', bdrId);
    const fpSet = new Set((fps || [])
      .filter((f: any) => f.effective_date)
      .map((f: any) => `${f.deal_id}|${String(f.effective_date).slice(0, 7)}`));
    const { data: entriesForFpFilter } = await supabase
      .from('commission_entries')
      .select('id, deal_id, payable_date, accrual_date, month')
      .in('id', filteredIds);
    filteredIds = (entriesForFpFilter || [])
      .filter((e: any) => {
        const ed = e.payable_date || e.accrual_date || (e.month ? `${e.month}-01` : null);
        if (!ed) return true;
        const monthKey = String(ed).slice(0, 7);
        return !fpSet.has(`${e.deal_id}|${monthKey}`);
      })
      .map((e: any) => e.id);

    if (filteredIds.length === 0) {
      return apiError('No eligible commission entries to include in report', 400);
    }

    const { data: batch, error: batchError } = await supabase
      .from('commission_batches')
      .insert({ bdr_id: bdrId, run_date: today, status: 'draft' })
      .select()
      .single();

    if (batchError || !batch) {
      return apiError(batchError?.message || 'Failed to create batch', 500);
    }

    // Attach entries
    await supabase
      .from('commission_entries')
      .update({ invoiced_batch_id: batch.id })
      .in('id', filteredIds);

    const batchItems = filteredIds.map((entryId: string) => ({
      batch_id: batch.id,
      commission_entry_id: entryId,
    }));

    await supabase.from('commission_batch_items').insert(batchItems);

    // Fetch full batch with items
    const { data: fullBatch } = await supabase
      .from('commission_batches')
      .select(`
        *,
        commission_batch_items(
          *,
          commission_entries(amount, deal_id, payable_date, accrual_date, month, deals(client_name, service_type), revenue_events(collection_date, deal_services(service_name, commission_rate, billing_type)))
        )
      `)
      .eq('id', batch.id)
      .single();

    return apiSuccess(fullBatch || batch, 201, { cache: 'no-store' });
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission batches create API error:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}
