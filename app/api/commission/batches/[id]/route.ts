import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { generateUUID } from '@/lib/utils/uuid';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * GET /api/commission/batches/[id]
 * Get batch with items and deal/client/service details.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const batch = db.prepare(`
        SELECT cb.*, br.name as bdr_name, br.email as bdr_email
        FROM commission_batches cb
        LEFT JOIN bdr_reps br ON cb.bdr_id = br.id
        WHERE cb.id = ?
      `).get(id) as any;

      if (!batch) {
        return apiError('Batch not found', 404);
      }

      const canAccess = await canAccessBdr(batch.bdr_id);
      if (!canAccess) {
        return apiError('Forbidden', 403);
      }

      // Use snapshot for approved/paid (immutable; survives reprocessing CASCADE)
      if ((batch.status === 'approved' || batch.status === 'paid') as boolean) {
        const snapshot = db.prepare('SELECT snapshot_data FROM commission_batch_snapshots WHERE batch_id = ?').get(id) as { snapshot_data: string } | undefined;
        if (snapshot?.snapshot_data) {
          const rows = JSON.parse(snapshot.snapshot_data) as Array<{
            client_name: string;
            deal: string;
            payable_date: string;
            amount_claimed_on: string;
            is_renewal: string;
            previous_deal_amount: string;
            new_deal_amount: string;
            commission_pct: string;
            original_commission: string;
            override_amount: string;
            final_invoiced_amount: string;
          }>;
          const { snapshotRowsToBatchItems } = await import('@/lib/commission/export-rows');
          const items = snapshotRowsToBatchItems(rows, id);
          return apiSuccess({
            ...batch,
            items,
          }, 200, { cache: 'no-store' });
        }
      }

      const items = db.prepare(`
        SELECT 
          cbi.id,
          cbi.commission_entry_id,
          cbi.override_amount,
          cbi.override_payment_date,
          cbi.override_commission_rate,
          cbi.adjustment_note,
          ce.amount,
          ce.deal_id,
          ce.payable_date,
          ce.accrual_date,
          ce.month,
          d.client_name,
          d.service_type,
          d.deal_value,
          d.original_deal_value,
          d.is_renewal as deal_is_renewal,
          ds.service_name,
          ds.id as service_id,
          ds.commission_rate,
          ds.billing_type,
          ds.is_renewal as service_is_renewal,
          ds.original_service_value,
          ds.commissionable_value,
          re.id as revenue_event_id,
          re.billing_type as revenue_billing_type,
          re.collection_date,
          re.amount_collected
        FROM commission_batch_items cbi
        JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
        JOIN deals d ON ce.deal_id = d.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
        WHERE cbi.batch_id = ?
      `).all(id) as any[];

      return apiSuccess({
        ...batch,
        items: items.map((i) => {
          const isRenewal = !!(i.service_is_renewal === 1 || i.service_is_renewal === true || i.deal_is_renewal === 1 || i.deal_is_renewal === true || i.revenue_billing_type === 'renewal');
          let previous_deal_amount: number | null = null;
          let new_deal_amount: number | null = null;
          if (isRenewal) {
            const storedNew = i.commissionable_value ?? i.deal_value ?? 0;
            const storedPrev = i.original_service_value ?? i.original_deal_value;
            const uplift = Number(i.amount_collected ?? 0);
            if (i.revenue_billing_type === 'renewal' && uplift > 0 && storedNew > 0) {
              const numNew = Number(storedNew);
              if (storedPrev == null || Number(storedPrev) === numNew) {
                previous_deal_amount = Math.max(0, numNew - uplift);
                new_deal_amount = numNew;
              } else {
                previous_deal_amount = Number(storedPrev ?? 0);
                new_deal_amount = numNew;
              }
            } else if (i.original_service_value != null || i.commissionable_value != null) {
              previous_deal_amount = Number(i.original_service_value ?? 0);
              new_deal_amount = Number(i.commissionable_value ?? 0);
            } else {
              previous_deal_amount = Number(i.original_deal_value ?? 0);
              new_deal_amount = Number(i.deal_value ?? 0);
            }
          }
          return {
            id: i.id,
            commission_entry_id: i.commission_entry_id,
            override_amount: i.override_amount,
            override_payment_date: i.override_payment_date,
            override_commission_rate: i.override_commission_rate,
            adjustment_note: i.adjustment_note,
            amount: i.amount,
            client_name: i.client_name,
            service_type: i.service_type,
            service_name: i.service_name,
            commission_rate: i.commission_rate,
            billing_type: i.billing_type,
            collection_date: i.collection_date,
            amount_collected: i.amount_collected,
            commissionable_value: i.commissionable_value ?? null,
            is_renewal: isRenewal,
            previous_deal_amount: isRenewal ? previous_deal_amount : null,
            new_deal_amount: isRenewal ? new_deal_amount : null,
            payable_date: i.payable_date,
            accrual_date: i.accrual_date,
            month: i.month,
            deal_id: i.deal_id,
          };
        }),
      }, 200, { cache: 'no-store' });
    }

    // Supabase mode
    const supabase = await createClient();

    const { data: batch, error: batchError } = await supabase
      .from('commission_batches')
      .select(`
        *,
        bdr_reps(name, email)
      `)
      .eq('id', id)
      .single();

    if (batchError || !batch) {
      return apiError('Batch not found', 404);
    }

    const canAccess = await canAccessBdr(batch.bdr_id);
    if (!canAccess) {
      return apiError('Forbidden', 403);
    }

    // Use snapshot for approved/paid (immutable)
    if (batch.status === 'approved' || batch.status === 'paid') {
      const { data: snapshot } = await supabase
        .from('commission_batch_snapshots')
        .select('snapshot_data')
        .eq('batch_id', id)
        .single();
      if (snapshot?.snapshot_data) {
        const rows = Array.isArray(snapshot.snapshot_data) ? snapshot.snapshot_data : (snapshot.snapshot_data as any);
        const { snapshotRowsToBatchItems } = await import('@/lib/commission/export-rows');
        const items = snapshotRowsToBatchItems(rows, id);
        return apiSuccess({
          ...batch,
          bdr_name: Array.isArray(batch.bdr_reps) ? batch.bdr_reps[0]?.name : batch.bdr_reps?.name,
          bdr_email: Array.isArray(batch.bdr_reps) ? batch.bdr_reps[0]?.email : batch.bdr_reps?.email,
          items,
        }, 200, { cache: 'no-store' });
      }
    }

    const { data: batchItems } = await supabase
      .from('commission_batch_items')
      .select(`
        id,
        commission_entry_id,
        override_amount,
        override_payment_date,
        override_commission_rate,
        adjustment_note,
        commission_entries(
          amount,
          deal_id,
          payable_date,
          accrual_date,
          month,
          deals(client_name, service_type, deal_value, original_deal_value, is_renewal),
          revenue_events(billing_type, collection_date, amount_collected, deal_services(service_name, commission_rate, billing_type, is_renewal, original_service_value, commissionable_value))
        )
      `)
      .eq('batch_id', id);

    const items = (batchItems || []).map((item: any) => {
      const ce = item.commission_entries;
      const ceObj = Array.isArray(ce) ? ce[0] : ce;
      const revenueEvent = ceObj?.revenue_events;
      const reObj = Array.isArray(revenueEvent) ? revenueEvent[0] : revenueEvent;
      const dealService = reObj?.deal_services;
      const dsObj = Array.isArray(dealService) ? dealService[0] : dealService;
      const deal = ceObj?.deals;
      const dealObj = Array.isArray(deal) ? deal[0] : deal;
      const isRenewal = !!(dsObj?.is_renewal || dealObj?.is_renewal || reObj?.billing_type === 'renewal');

      let previous_deal_amount: number | null = null;
      let new_deal_amount: number | null = null;
      if (isRenewal) {
        const storedNew = dsObj?.commissionable_value ?? dealObj?.deal_value ?? 0;
        const storedPrev = dsObj?.original_service_value ?? dealObj?.original_deal_value;
        const uplift = Number(reObj?.amount_collected ?? 0);
        if (reObj?.billing_type === 'renewal' && uplift > 0 && storedNew > 0) {
          const numNew = Number(storedNew);
          if (storedPrev == null || Number(storedPrev) === numNew) {
            previous_deal_amount = Math.max(0, numNew - uplift);
            new_deal_amount = numNew;
          } else {
            previous_deal_amount = Number(storedPrev ?? 0);
            new_deal_amount = numNew;
          }
        } else if (dsObj && (dsObj.original_service_value != null || dsObj.commissionable_value != null)) {
          previous_deal_amount = Number(dsObj.original_service_value ?? 0);
          new_deal_amount = Number(dsObj.commissionable_value ?? 0);
        } else {
          previous_deal_amount = Number(dealObj?.original_deal_value ?? 0);
          new_deal_amount = Number(dealObj?.deal_value ?? 0);
        }
      }

      return {
        id: item.id,
        commission_entry_id: item.commission_entry_id,
        override_amount: item.override_amount,
        override_payment_date: item.override_payment_date,
        override_commission_rate: item.override_commission_rate,
        adjustment_note: item.adjustment_note,
        amount: ceObj?.amount ?? 0,
        client_name: dealObj?.client_name ?? '',
        service_type: dealObj?.service_type ?? '',
        service_name: dsObj?.service_name ?? '',
        commission_rate: dsObj?.commission_rate ?? null,
        billing_type: dsObj?.billing_type ?? '',
        collection_date: reObj?.collection_date ?? '',
        amount_collected: reObj?.amount_collected ?? 0,
        commissionable_value: dsObj?.commissionable_value ?? dealObj?.deal_value ?? null,
        is_renewal: isRenewal,
        previous_deal_amount: isRenewal ? previous_deal_amount : null,
        new_deal_amount: isRenewal ? new_deal_amount : null,
        payable_date: ceObj?.payable_date,
        accrual_date: ceObj?.accrual_date,
        month: ceObj?.month,
        deal_id: ceObj?.deal_id,
      };
    });

    return apiSuccess({
      ...batch,
      bdr_name: Array.isArray(batch.bdr_reps) ? batch.bdr_reps[0]?.name : batch.bdr_reps?.name,
      bdr_email: Array.isArray(batch.bdr_reps) ? batch.bdr_reps[0]?.email : batch.bdr_reps?.email,
      items,
    }, 200, { cache: 'no-store' });
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission batch GET error:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}

/**
 * PATCH /api/commission/batches/[id]
 * Draft edits: remove_entry, adjust_amount, add_note. Only when status = 'draft'.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    const body = await request.json().catch(() => ({}));
    const { action, commission_entry_id, override_amount, adjustment_note, override_payment_date, override_commission_rate, previous_deal_amount } = body;

    if (!action) {
      return apiError('action required', 400);
    }
    if (action !== 'add_missing_entries' && !commission_entry_id) {
      return apiError('commission_entry_id required for this action', 400);
    }

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const batch = db.prepare('SELECT * FROM commission_batches WHERE id = ?').get(id) as any;
      if (!batch) {
        return apiError('Batch not found', 404);
      }
      if (batch.status !== 'draft') {
        return apiError('Batch is not in draft status; cannot edit', 400);
      }

      const canAccess = await canAccessBdr(batch.bdr_id);
      if (!canAccess) {
        return apiError('Forbidden', 403);
      }

      // Add missing eligible entries: due for payment, not in any batch, not in approved/paid report
      if (action === 'add_missing_entries') {
        const today = new Date().toISOString().split('T')[0];
        // Match fingerprints by (deal_id, month) - excludes already paid regardless of amount/date format
        const missing = db.prepare(`
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
        `).all(batch.bdr_id) as Array<{ id: string }>;

        if (missing.length === 0) {
          return apiSuccess({ success: true, added_count: 0, message: 'No additional eligible entries found' });
        }

        const updateEntry = db.prepare(`
          UPDATE commission_entries SET invoiced_batch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `);
        const insertItem = db.prepare(`
          INSERT INTO commission_batch_items (id, batch_id, commission_entry_id)
          VALUES (?, ?, ?)
        `);

        for (const entry of missing) {
          updateEntry.run(id, entry.id);
          insertItem.run(generateUUID(), id, entry.id);
        }

        return apiSuccess({ success: true, added_count: missing.length });
      }

      const itemExists = db.prepare(
        'SELECT 1 FROM commission_batch_items WHERE batch_id = ? AND commission_entry_id = ?'
      ).get(id, commission_entry_id);

      if (!itemExists) {
        return apiError('Entry not found in batch', 404);
      }

      if (action === 'remove_entry') {
        db.prepare('UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(commission_entry_id);
        db.prepare('DELETE FROM commission_batch_items WHERE batch_id = ? AND commission_entry_id = ?').run(id, commission_entry_id);
        return apiSuccess({ success: true, removed: commission_entry_id });
      }

      if (action === 'adjust_amount') {
        if (typeof override_amount !== 'number' && override_amount !== null) {
          return apiError('override_amount must be a number or null', 400);
        }
        db.prepare(`
          UPDATE commission_batch_items 
          SET override_amount = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE batch_id = ? AND commission_entry_id = ?
        `).run(override_amount, id, commission_entry_id);
        // Sync override to commission entry so it persists (used in dashboard, future reports, etc.)
        if (override_amount != null && typeof override_amount === 'number') {
          db.prepare("UPDATE commission_entries SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(override_amount, commission_entry_id);
        }
        return apiSuccess({ success: true });
      }

      if (action === 'add_note') {
        db.prepare(`
          UPDATE commission_batch_items 
          SET adjustment_note = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE batch_id = ? AND commission_entry_id = ?
        `).run(adjustment_note ?? null, id, commission_entry_id);
        return apiSuccess({ success: true });
      }

      if (action === 'update_payment_date') {
        db.prepare(`
          UPDATE commission_batch_items 
          SET override_payment_date = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE batch_id = ? AND commission_entry_id = ?
        `).run(override_payment_date ?? null, id, commission_entry_id);

        // Sync override to commission entry so it persists
        if (override_payment_date) {
          db.prepare("UPDATE commission_entries SET payable_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(override_payment_date, commission_entry_id);
        }

        const today = new Date().toISOString().split('T')[0];
        let effectiveDate = override_payment_date;
        if (!effectiveDate) {
          const ce = db.prepare('SELECT payable_date, accrual_date, month FROM commission_entries WHERE id = ?').get(commission_entry_id) as any;
          effectiveDate = ce?.payable_date ?? ce?.accrual_date ?? (ce?.month ? `${String(ce.month)}-01` : null);
        }
        if (effectiveDate && effectiveDate > today) {
          db.prepare('UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(commission_entry_id);
          db.prepare('DELETE FROM commission_batch_items WHERE batch_id = ? AND commission_entry_id = ?').run(id, commission_entry_id);
          return apiSuccess({ success: true, removed: commission_entry_id });
        }
        return apiSuccess({ success: true });
      }

      if (action === 'update_commission_rate') {
        if (typeof override_commission_rate !== 'number' && override_commission_rate !== null) {
          return apiError('override_commission_rate must be a number (e.g. 0.025 for 2.5%) or null', 400);
        }
        db.prepare(`
          UPDATE commission_batch_items 
          SET override_commission_rate = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE batch_id = ? AND commission_entry_id = ?
        `).run(override_commission_rate, id, commission_entry_id);
        // Sync to deal_services so it persists and affects future commission calculations
        const ceRow = db.prepare(`
          SELECT ce.service_id, re.service_id as re_service_id
          FROM commission_entries ce
          LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
          WHERE ce.id = ?
        `).get(commission_entry_id) as { service_id: string | null; re_service_id: string | null } | undefined;
        const serviceId = ceRow?.service_id || ceRow?.re_service_id;
        if (serviceId && override_commission_rate != null) {
          db.prepare('UPDATE deal_services SET commission_rate = ?, updated_at = datetime(\'now\') WHERE id = ?').run(override_commission_rate, serviceId);
        }
        return apiSuccess({ success: true });
      }

      if (action === 'override_to_renewal') {
        if (typeof previous_deal_amount !== 'number' || previous_deal_amount < 0) {
          return apiError('previous_deal_amount must be a non-negative number', 400);
        }
        const row = db.prepare(`
          SELECT ce.deal_id, ce.revenue_event_id,
                 re.amount_collected,
                 ds.id as service_id, ds.commissionable_value, ds.commission_rate,
                 d.deal_value, d.original_deal_value
          FROM commission_entries ce
          LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
          LEFT JOIN deal_services ds ON re.service_id = ds.id
          INNER JOIN deals d ON ce.deal_id = d.id
          WHERE ce.id = ?
        `).get(commission_entry_id) as any;
        if (!row) {
          return apiError('Commission entry not found', 404);
        }
        const prev = Number(previous_deal_amount);
        const newAmount = Number(row.commissionable_value ?? row.amount_collected ?? row.deal_value ?? 0);
        const uplift = Math.max(0, newAmount - prev);
        const rate = Number(row.commission_rate ?? 0.025);
        const commissionAmount = Number((uplift * rate).toFixed(2));

        if (row.service_id) {
          db.prepare(`
            UPDATE deal_services SET is_renewal = 1, original_service_value = ?, commission_amount = ?, updated_at = datetime('now') WHERE id = ?
          `).run(prev, commissionAmount, row.service_id);
        }
        db.prepare(`UPDATE deals SET is_renewal = 1, original_deal_value = COALESCE(original_deal_value, ?), updated_at = datetime('now') WHERE id = ?`).run(prev, row.deal_id);
        if (row.revenue_event_id) {
          db.prepare(`UPDATE revenue_events SET amount_collected = ?, billing_type = 'renewal', updated_at = datetime('now') WHERE id = ?`).run(uplift, row.revenue_event_id);
        }
        db.prepare(`UPDATE commission_entries SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(commissionAmount, commission_entry_id);
        db.prepare(`UPDATE commission_batch_items SET override_amount = NULL, updated_at = CURRENT_TIMESTAMP WHERE batch_id = ? AND commission_entry_id = ?`).run(id, commission_entry_id);
        return apiSuccess({ success: true });
      }

      return apiError('Invalid action', 400);
    }

    // Supabase mode
    const supabase = await createClient();

    const { data: batch, error: batchError } = await supabase
      .from('commission_batches')
      .select('*')
      .eq('id', id)
      .single();

    if (batchError || !batch) {
      return apiError('Batch not found', 404);
    }
    if (batch.status !== 'draft') {
      return apiError('Batch is not in draft status; cannot edit', 400);
    }

    const canAccess = await canAccessBdr(batch.bdr_id);
    if (!canAccess) {
      return apiError('Forbidden', 403);
    }

    if (action === 'add_missing_entries') {
      const today = new Date().toISOString().split('T')[0];
      const { data: entriesWithDates } = await supabase
        .from('commission_entries')
        .select('id, payable_date, accrual_date, month, deal_id, deals!inner(cancellation_date)')
        .eq('bdr_id', batch.bdr_id)
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

      // Exclude entries already in approved/paid reports
      const { data: approvedBatches } = await supabase
        .from('commission_batches')
        .select('id')
        .in('status', ['approved', 'paid']);
      const approvedBatchIds = (approvedBatches || []).map((b: any) => b.id);
      if (approvedBatchIds.length > 0) {
        const { data: items } = await supabase
          .from('commission_batch_items')
          .select('commission_entry_id')
          .in('batch_id', approvedBatchIds);
        const alreadyApprovedIds = new Set((items || []).map((i: any) => i.commission_entry_id));
        filteredIds = filteredIds.filter((id: string) => !alreadyApprovedIds.has(id));
      }

      // Exclude by approved_commission_fingerprints (survives reprocessing)
      // Match on (deal_id, month) - if we paid that deal+month, exclude regardless of amount/date format
      const { data: fps } = await supabase
        .from('approved_commission_fingerprints')
        .select('deal_id, effective_date')
        .eq('bdr_id', batch.bdr_id);
      const fpSet = new Set((fps || [])
        .filter((f: any) => f.effective_date)
        .map((f: any) => `${f.deal_id}|${String(f.effective_date).slice(0, 7)}`));
      const { data: entriesForFp } = await supabase
        .from('commission_entries')
        .select('id, deal_id, payable_date, accrual_date, month')
        .in('id', filteredIds);
      filteredIds = (entriesForFp || [])
        .filter((e: any) => {
          const ed = e.payable_date || e.accrual_date || (e.month ? `${e.month}-01` : null);
          if (!ed) return true;
          const monthKey = String(ed).slice(0, 7);
          return !fpSet.has(`${e.deal_id}|${monthKey}`);
        })
        .map((e: any) => e.id);

      if (filteredIds.length === 0) {
        return apiSuccess({ success: true, added_count: 0, message: 'No additional eligible entries found' });
      }

      await supabase
        .from('commission_entries')
        .update({ invoiced_batch_id: id })
        .in('id', filteredIds);

      const batchItems = filteredIds.map((entryId: string) => ({
        batch_id: id,
        commission_entry_id: entryId,
      }));
      await supabase.from('commission_batch_items').insert(batchItems);

      return apiSuccess({ success: true, added_count: filteredIds.length });
    }

    if (action === 'remove_entry') {
      await supabase
        .from('commission_entries')
        .update({ invoiced_batch_id: null })
        .eq('id', commission_entry_id);

      await supabase
        .from('commission_batch_items')
        .delete()
        .eq('batch_id', id)
        .eq('commission_entry_id', commission_entry_id);

      return apiSuccess({ success: true, removed: commission_entry_id });
    }

    if (action === 'adjust_amount') {
      if (typeof override_amount !== 'number' && override_amount !== null) {
        return apiError('override_amount must be a number or null', 400);
      }
      const { error } = await supabase
        .from('commission_batch_items')
        .update({ override_amount: override_amount })
        .eq('batch_id', id)
        .eq('commission_entry_id', commission_entry_id);

      if (error) return apiError(error.message, 500);
      // Sync override to commission entry so it persists (used in dashboard, future reports, etc.)
      if (override_amount != null && typeof override_amount === 'number') {
        await supabase.from('commission_entries').update({ amount: override_amount }).eq('id', commission_entry_id);
      }
      return apiSuccess({ success: true });
    }

    if (action === 'add_note') {
      const { error } = await supabase
        .from('commission_batch_items')
        .update({ adjustment_note: adjustment_note ?? null })
        .eq('batch_id', id)
        .eq('commission_entry_id', commission_entry_id);

      if (error) return apiError(error.message, 500);
      return apiSuccess({ success: true });
    }

    if (action === 'update_payment_date') {
      const { error } = await supabase
        .from('commission_batch_items')
        .update({ override_payment_date: override_payment_date ?? null })
        .eq('batch_id', id)
        .eq('commission_entry_id', commission_entry_id);

      if (error) return apiError(error.message, 500);
      // Sync override to commission entry so it persists
      if (override_payment_date) {
        await supabase.from('commission_entries').update({ payable_date: override_payment_date }).eq('id', commission_entry_id);
      }

      const today = new Date().toISOString().split('T')[0];
      let effectiveDate = override_payment_date;
      if (!effectiveDate) {
        const { data: ce } = await supabase
          .from('commission_entries')
          .select('payable_date, accrual_date, month')
          .eq('id', commission_entry_id)
          .single();
        effectiveDate = ce?.payable_date ?? ce?.accrual_date ?? (ce?.month ? `${ce.month}-01` : null);
      }
      if (effectiveDate && effectiveDate > today) {
        await supabase
          .from('commission_entries')
          .update({ invoiced_batch_id: null })
          .eq('id', commission_entry_id);
        await supabase
          .from('commission_batch_items')
          .delete()
          .eq('batch_id', id)
          .eq('commission_entry_id', commission_entry_id);
        return apiSuccess({ success: true, removed: commission_entry_id });
      }
      return apiSuccess({ success: true });
    }

    if (action === 'update_commission_rate') {
      if (typeof override_commission_rate !== 'number' && override_commission_rate !== null) {
        return apiError('override_commission_rate must be a number (e.g. 0.025 for 2.5%) or null', 400);
      }
      const { error } = await supabase
        .from('commission_batch_items')
        .update({ override_commission_rate: override_commission_rate })
        .eq('batch_id', id)
        .eq('commission_entry_id', commission_entry_id);

      if (error) return apiError(error.message, 500);
      // Sync to deal_services so it persists and affects future commission calculations
      const { data: ce } = await supabase
        .from('commission_entries')
        .select('service_id, revenue_events(service_id)')
        .eq('id', commission_entry_id)
        .single();
      const serviceId = (ce as any)?.service_id || (ce as any)?.revenue_events?.service_id;
      if (serviceId && override_commission_rate != null) {
        await supabase.from('deal_services').update({ commission_rate: override_commission_rate }).eq('id', serviceId);
      }
      return apiSuccess({ success: true });
    }

    if (action === 'override_to_renewal') {
      if (typeof previous_deal_amount !== 'number' || previous_deal_amount < 0) {
        return apiError('previous_deal_amount must be a non-negative number', 400);
      }
      const { data: ce, error: ceErr } = await supabase
        .from('commission_entries')
        .select('deal_id, revenue_event_id')
        .eq('id', commission_entry_id)
        .single();
      if (ceErr || !ce) return apiError('Commission entry not found', 404);
      let newAmt = 0, rate = 0.025, serviceId: string | null = null, reId: string | null = null;
      if (ce.revenue_event_id) {
        const { data: re } = await supabase
          .from('revenue_events')
          .select('id, amount_collected, service_id')
          .eq('id', ce.revenue_event_id)
          .single();
        if (re) {
          reId = re.id;
          newAmt = Number(re.amount_collected ?? 0);
          if (re.service_id) {
            serviceId = re.service_id;
            const { data: ds } = await supabase
              .from('deal_services')
              .select('commissionable_value, commission_rate')
              .eq('id', re.service_id)
              .single();
            if (ds) {
              newAmt = Number(ds.commissionable_value ?? newAmt);
              rate = Number(ds.commission_rate ?? 0.025);
            }
          }
        }
      }
      if (newAmt <= 0) {
        const { data: d } = await supabase.from('deals').select('deal_value').eq('id', ce.deal_id).single();
        newAmt = Number(d?.deal_value ?? 0);
      }
      const prev = Number(previous_deal_amount);
      const uplift = Math.max(0, newAmt - prev);
      const commissionAmount = Number((uplift * rate).toFixed(2));
      if (serviceId) {
        await supabase
          .from('deal_services')
          .update({ is_renewal: true, original_service_value: prev, commission_amount: commissionAmount })
          .eq('id', serviceId);
      }
      const { data: dealRow } = await supabase.from('deals').select('original_deal_value').eq('id', ce.deal_id).single();
      await supabase
        .from('deals')
        .update({ is_renewal: true, original_deal_value: dealRow?.original_deal_value ?? prev })
        .eq('id', ce.deal_id);
      if (reId) {
        await supabase
          .from('revenue_events')
          .update({ amount_collected: uplift, billing_type: 'renewal' })
          .eq('id', reId);
      }
      await supabase.from('commission_entries').update({ amount: commissionAmount }).eq('id', commission_entry_id);
      await supabase
        .from('commission_batch_items')
        .update({ override_amount: null })
        .eq('batch_id', id)
        .eq('commission_entry_id', commission_entry_id);
      return apiSuccess({ success: true });
    }

    return apiError('Invalid action', 400);
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission batch PATCH error:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}

/**
 * DELETE /api/commission/batches/[id]
 * Discard a draft batch. Sets invoiced_batch_id = NULL on all entries, deletes batch and items.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const batch = db.prepare('SELECT * FROM commission_batches WHERE id = ?').get(id) as any;
      if (!batch) {
        return apiError('Batch not found', 404);
      }
      if (batch.status !== 'draft') {
        return apiError('Only draft batches can be discarded', 400);
      }

      const canAccess = await canAccessBdr(batch.bdr_id);
      if (!canAccess) {
        return apiError('Forbidden', 403);
      }

      // SQLite has no CASCADE on approved_commission_fingerprints; clean up in case of orphaned data
      db.prepare('DELETE FROM approved_commission_fingerprints WHERE batch_id = ?').run(id);
      db.prepare('UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE invoiced_batch_id = ?').run(id);
      db.prepare('DELETE FROM commission_batch_items WHERE batch_id = ?').run(id);
      db.prepare('DELETE FROM commission_batches WHERE id = ?').run(id);

      return apiSuccess({ success: true, deleted: id });
    }

    // Supabase mode
    const supabase = await createClient();

    const { data: batch, error: batchError } = await supabase
      .from('commission_batches')
      .select('*')
      .eq('id', id)
      .single();

    if (batchError || !batch) {
      return apiError('Batch not found', 404);
    }
    if (batch.status !== 'draft') {
      return apiError('Only draft batches can be discarded', 400);
    }

    const canAccess = await canAccessBdr(batch.bdr_id);
    if (!canAccess) {
      return apiError('Forbidden', 403);
    }

    await supabase.from('commission_entries').update({ invoiced_batch_id: null }).eq('invoiced_batch_id', id);
    await supabase.from('commission_batch_items').delete().eq('batch_id', id);
    await supabase.from('commission_batches').delete().eq('id', id);

    return apiSuccess({ success: true, deleted: id });
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission batch DELETE error:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}
