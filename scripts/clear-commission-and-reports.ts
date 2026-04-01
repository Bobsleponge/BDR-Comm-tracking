/**
 * Clear all commission entries and generated reports.
 * Does NOT touch deals, deal_services, or revenue_events.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/clear-commission-and-reports.ts
 *
 * Removes:
 * - commission_entries
 * - commission_batches (CASCADE: batch_items, snapshots)
 * - approved_commission_fingerprints
 */

const USE_LOCAL_DB =
  process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function main() {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('../lib/db/local-db');
    const db = getLocalDB();

    console.log('Clearing commission entries and generated reports (local DB)...\n');

    // 1. Delete batches first (CASCADE deletes commission_batch_items, commission_batch_snapshots)
    const batchesResult = db.prepare('DELETE FROM commission_batches').run();
    console.log(`Deleted ${batchesResult.changes} commission batches (reports)`);

    // 2. Delete commission entries
    const entriesResult = db.prepare('DELETE FROM commission_entries').run();
    console.log(`Deleted ${entriesResult.changes} commission entries`);

    // 3. Clear fingerprints (used to exclude already-paid from new reports)
    const fpResult = db.prepare('DELETE FROM approved_commission_fingerprints').run();
    console.log(`Deleted ${fpResult.changes} approved commission fingerprints`);

    console.log('\nDone. Deals and revenue_events unchanged. Run Reprocess All to regenerate commission entries.');
  } else {
    const { createClient } = await import('../lib/supabase/server');
    const supabase = await createClient();

    console.log('Clearing commission entries and generated reports (Supabase)...\n');

    // 1. Delete commission_batches (CASCADE to batch_items, snapshots)
    const { count: batchCount } = await supabase
      .from('commission_batches')
      .select('*', { count: 'exact', head: true });
    const { error: batchErr } = await supabase
      .from('commission_batches')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (batchErr) {
      console.error('Error deleting batches:', batchErr);
    } else {
      console.log(`Deleted commission batches (reports)`);
    }

    // 2. Delete commission_entries in batches
    let totalEntries = 0;
    while (true) {
      const { data: entries } = await supabase
        .from('commission_entries')
        .select('id')
        .limit(1000);
      if (!entries || entries.length === 0) break;
      const ids = entries.map((e) => e.id);
      const { error } = await supabase
        .from('commission_entries')
        .delete()
        .in('id', ids);
      if (error) {
        console.error('Error deleting commission entries:', error);
        break;
      }
      totalEntries += entries.length;
    }
    console.log(`Deleted ${totalEntries} commission entries`);

    // 3. Clear approved_commission_fingerprints
    const { error: fpErr } = await supabase
      .from('approved_commission_fingerprints')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (fpErr) {
      console.error('Error deleting fingerprints:', fpErr);
    } else {
      console.log('Deleted approved commission fingerprints');
    }

    console.log('\nDone. Deals and revenue_events unchanged. Run Reprocess All to regenerate commission entries.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
