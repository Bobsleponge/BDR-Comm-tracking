const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function deleteAllCommissionEntries() {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('../lib/db/local-db');
    const db = getLocalDB();

    console.log('Deleting all commission entries from local database...\n');

    // Get count before deletion
    const countBefore = db.prepare('SELECT COUNT(*) as count FROM commission_entries').get() as { count: number };
    console.log(`Found ${countBefore.count} commission entries to delete\n`);

    // Delete all commission entries
    const result = db.prepare('DELETE FROM commission_entries').run();

    console.log(`✓ Deleted ${result.changes} commission entries`);
    console.log('\n✓ All commission entries have been removed.');
    console.log('✓ Deals and revenue events remain intact.');
  } else {
    const { createClient } = await import('../lib/supabase/server');
    const supabase = await createClient();

    console.log('Deleting all commission entries from Supabase...\n');

    // Get all commission entry IDs
    const { data: entries, error: fetchError } = await supabase
      .from('commission_entries')
      .select('id')
      .limit(10000);

    if (fetchError) {
      console.error('Error fetching commission entries:', fetchError);
      process.exit(1);
    }

    const count = entries?.length || 0;
    console.log(`Found ${count} commission entries to delete\n`);

    if (count > 0) {
      // Delete in batches if needed
      const batchSize = 1000;
      let deleted = 0;
      
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        const ids = batch.map(e => e.id);
        
        const { error: deleteError } = await supabase
          .from('commission_entries')
          .delete()
          .in('id', ids);
        
        if (deleteError) {
          console.error(`Error deleting batch ${Math.floor(i / batchSize) + 1}:`, deleteError);
        } else {
          deleted += batch.length;
          console.log(`Deleted batch ${Math.floor(i / batchSize) + 1}: ${batch.length} entries`);
        }
      }

      console.log(`\n✓ Deleted ${deleted} commission entries`);
    } else {
      console.log('No commission entries found to delete');
    }

    console.log('\n✓ All commission entries have been removed.');
    console.log('✓ Deals and revenue events remain intact.');
  }
}

deleteAllCommissionEntries().then(() => {
  console.log('\nDone!');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

