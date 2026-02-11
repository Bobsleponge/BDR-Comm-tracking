/**
 * Script to clear all commission entries and revenue events
 * This will NOT delete deals or deal_services
 */

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function clearCommissionEntries() {
  if (USE_LOCAL_DB) {
    const { getLocalDB } = await import('../lib/db/local-db');
    const db = getLocalDB();

    console.log('Clearing commission entries from local database...');
    
    // Delete all commission entries
    const commissionEntriesResult = db.prepare('DELETE FROM commission_entries').run();
    console.log(`Deleted ${commissionEntriesResult.changes} commission entries`);

    // Delete all revenue events (since they can be regenerated from deals)
    const revenueEventsResult = db.prepare('DELETE FROM revenue_events').run();
    console.log(`Deleted ${revenueEventsResult.changes} revenue events`);

    console.log('✅ All commission entries and revenue events cleared. Deals remain intact.');
  } else {
    const { createClient } = await import('../lib/supabase/server');
    const supabase = await createClient();

    console.log('Clearing commission entries from Supabase...');

    // Delete all commission entries
    const { error: commissionError, count: commissionCount } = await supabase
      .from('commission_entries')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all (using a condition that matches all)

    if (commissionError) {
      console.error('Error deleting commission entries:', commissionError);
      // Try alternative approach - get all IDs and delete
      const { data: entries } = await supabase
        .from('commission_entries')
        .select('id')
        .limit(10000);
      
      if (entries && entries.length > 0) {
        const ids = entries.map(e => e.id);
        const { error: deleteError } = await supabase
          .from('commission_entries')
          .delete()
          .in('id', ids);
        
        if (deleteError) {
          console.error('Error deleting commission entries:', deleteError);
        } else {
          console.log(`Deleted ${entries.length} commission entries`);
        }
      }
    } else {
      console.log(`Deleted commission entries`);
    }

    // Delete all revenue events
    const { error: revenueError } = await supabase
      .from('revenue_events')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');

    if (revenueError) {
      console.error('Error deleting revenue events:', revenueError);
      // Try alternative approach - get all IDs and delete
      const { data: events } = await supabase
        .from('revenue_events')
        .select('id')
        .limit(10000);
      
      if (events && events.length > 0) {
        const ids = events.map(e => e.id);
        const { error: deleteError } = await supabase
          .from('revenue_events')
          .delete()
          .in('id', ids);
        
        if (deleteError) {
          console.error('Error deleting revenue events:', deleteError);
        } else {
          console.log(`Deleted ${events.length} revenue events`);
        }
      }
    } else {
      console.log(`Deleted revenue events`);
    }

    console.log('✅ All commission entries and revenue events cleared. Deals remain intact.');
  }
}

clearCommissionEntries()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });

