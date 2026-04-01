/**
 * Fix orphaned commission data so entries show in new reports.
 *
 * When a report is reverted to draft or deleted, fingerprints and invoiced_batch_id
 * should be cleared so entries become eligible for new reports. This script fixes:
 * 1) Orphaned approved_commission_fingerprints (batch draft/deleted but fingerprints remain)
 * 2) Entries with invoiced_batch_id pointing to a draft or non-existent batch
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/fix-orphaned-approved-fingerprints.ts [--dry-run]
 */

const USE_LOCAL_DB =
  process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('../lib/db/local-db');
    const db = getLocalDB();

    console.log('Checking for orphaned commission data...\n');

    // 1) Fingerprints are valid only when batch is approved or paid
    const orphaned = db.prepare(`
      SELECT acf.id, acf.batch_id, acf.deal_id, acf.effective_date, acf.amount,
             cb.status as batch_status
      FROM approved_commission_fingerprints acf
      LEFT JOIN commission_batches cb ON acf.batch_id = cb.id
      WHERE cb.id IS NULL OR cb.status NOT IN ('approved', 'paid')
    `).all() as Array<{ id: string; batch_id: string; deal_id: string; effective_date: string; amount: number; batch_status: string | null }>;

    if (orphaned.length > 0) {
      console.log(`Found ${orphaned.length} orphaned fingerprint(s):`);
      orphaned.forEach((fp) => {
        const batchInfo = fp.batch_status == null ? '(batch deleted)' : `batch status=${fp.batch_status}`;
        console.log(`  - ${fp.id.slice(0, 8)}... deal=${fp.deal_id.slice(0, 8)}... ${fp.effective_date} $${fp.amount} ${batchInfo}`);
      });

      if (!DRY_RUN) {
        const ids = orphaned.map((o) => o.id);
        const stmt = db.prepare('DELETE FROM approved_commission_fingerprints WHERE id = ?');
        for (const id of ids) {
          stmt.run(id);
        }
        console.log(`\nRemoved ${orphaned.length} orphaned fingerprint(s).`);
      } else {
        console.log(`\n[--dry-run] Would remove ${orphaned.length} orphaned fingerprint(s).`);
      }
    } else {
      console.log('No orphaned approved commission fingerprints found.');
    }

    // 2) Clear invoiced_batch_id on entries pointing to draft or non-existent batch
    const staleEntries = db.prepare(`
      SELECT ce.id, ce.invoiced_batch_id, cb.status as batch_status
      FROM commission_entries ce
      LEFT JOIN commission_batches cb ON ce.invoiced_batch_id = cb.id
      WHERE ce.invoiced_batch_id IS NOT NULL AND ce.invoiced_batch_id != ''
        AND (cb.id IS NULL OR cb.status = 'draft')
    `).all() as Array<{ id: string; invoiced_batch_id: string; batch_status: string | null }>;

    if (staleEntries.length > 0) {
      console.log(`\nFound ${staleEntries.length} entries with stale invoiced_batch_id (draft or deleted batch):`);
      staleEntries.slice(0, 5).forEach((e) => {
        const info = e.batch_status == null ? '(batch deleted)' : 'draft';
        console.log(`  - ${e.id.slice(0, 8)}... batch=${e.invoiced_batch_id?.slice(0, 8)}... ${info}`);
      });
      if (staleEntries.length > 5) console.log(`  ... and ${staleEntries.length - 5} more`);

      if (!DRY_RUN) {
        const r = db.prepare('UPDATE commission_entries SET invoiced_batch_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE invoiced_batch_id = ?');
        const batchIds = [...new Set(staleEntries.map((e) => e.invoiced_batch_id))];
        for (const bid of batchIds) {
          r.run(bid);
        }
        console.log(`\nCleared invoiced_batch_id on ${staleEntries.length} entries. They are now eligible for new reports.`);
      } else {
        console.log(`\n[--dry-run] Would clear invoiced_batch_id on ${staleEntries.length} entries.`);
      }
    }

    if (DRY_RUN && (orphaned.length > 0 || (staleEntries?.length ?? 0) > 0)) {
      console.log('\nRun without --dry-run to apply changes.');
    } else if (!DRY_RUN) {
      console.log('\nDone.');
    }
  } else {
    const { createClient } = await import('../lib/supabase/server');
    const supabase = await createClient();

    console.log('Checking for orphaned commission data...\n');

    // 1) Orphaned fingerprints
    const { data: fps } = await supabase
      .from('approved_commission_fingerprints')
      .select('id, batch_id, deal_id, effective_date, amount');

    const batchIds = [...new Set(((fps || []) as any[]).map((fp) => fp.batch_id).filter(Boolean))];
    const { data: batches } = batchIds.length > 0
      ? await supabase.from('commission_batches').select('id, status').in('id', batchIds)
      : { data: [] };

    const validBatchIds = new Set(
      ((batches || []) as any[]).filter((b: any) => ['approved', 'paid'].includes(b.status)).map((b: any) => b.id)
    );
    const orphaned = ((fps || []) as any[]).filter((fp: any) => !validBatchIds.has(fp.batch_id));

    if (orphaned.length > 0) {
      const batchStatusById = new Map(((batches || []) as any[]).map((b: any) => [b.id, b.status]));
      console.log(`Found ${orphaned.length} orphaned fingerprint(s):`);
      orphaned.forEach((fp: any) => {
        const batchStatus = batchStatusById.get(fp.batch_id);
        const batchInfo = batchStatus == null ? '(batch deleted)' : `batch status=${batchStatus}`;
        console.log(`  - ${fp.id?.slice(0, 8)}... deal=${fp.deal_id?.slice(0, 8)}... ${fp.effective_date} $${fp.amount} ${batchInfo}`);
      });
      if (!DRY_RUN) {
        const ids = orphaned.map((fp: any) => fp.id).filter(Boolean);
        const { error } = await supabase.from('approved_commission_fingerprints').delete().in('id', ids);
        if (error) console.error('Error removing fingerprints:', error);
        else console.log(`\nRemoved ${orphaned.length} orphaned fingerprint(s).`);
      }
    } else {
      console.log('No orphaned approved commission fingerprints found.');
    }

    // 2) Stale invoiced_batch_id (entries pointing to draft or non-existent batch)
    const { data: entriesWithBatch } = await supabase
      .from('commission_entries')
      .select('id, invoiced_batch_id')
      .not('invoiced_batch_id', 'is', null);
    const batchIdsToCheck = [...new Set(((entriesWithBatch || []) as any[]).map((e: any) => e.invoiced_batch_id).filter(Boolean))];
    const { data: batchStatuses } = batchIdsToCheck.length > 0
      ? await supabase.from('commission_batches').select('id, status').in('id', batchIdsToCheck)
      : { data: [] };
    const validBatchIdSet = new Set(((batchStatuses || []) as any[]).map((b: any) => b.id));
    const staleBatchIds = batchIdsToCheck.filter((id) => {
      const b = ((batchStatuses || []) as any[]).find((x: any) => x.id === id);
      return !b || b.status === 'draft';
    });
    const staleCount = ((entriesWithBatch || []) as any[]).filter((e: any) => staleBatchIds.includes(e.invoiced_batch_id)).length;

    if (staleCount > 0) {
      console.log(`\nFound ${staleCount} entries with stale invoiced_batch_id (draft or deleted batch).`);
      if (!DRY_RUN && staleBatchIds.length > 0) {
        const { error } = await supabase
          .from('commission_entries')
          .update({ invoiced_batch_id: null })
          .in('invoiced_batch_id', staleBatchIds);
        if (error) console.error('Error clearing invoiced_batch_id:', error);
        else console.log(`Cleared invoiced_batch_id. Entries are now eligible for new reports.`);
      }
    }

    console.log(DRY_RUN ? '\nDone. Run without --dry-run to apply changes.' : '\nDone.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
