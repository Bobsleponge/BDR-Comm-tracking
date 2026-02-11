import { getLocalDB } from '../lib/db/local-db';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function deleteAllRevenueEvents() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  console.log('Deleting all revenue events...\n');

  // Get count before deletion
  const countBefore = db.prepare('SELECT COUNT(*) as count FROM revenue_events').get() as { count: number };
  console.log(`Found ${countBefore.count} revenue events to delete\n`);

  // Delete all revenue events
  const result = db.prepare('DELETE FROM revenue_events').run();

  console.log(`✓ Deleted ${result.changes} revenue events`);
  console.log('\n✓ All revenue events have been removed.');
  console.log('✓ Deals remain intact.');
  console.log('✓ Commission entries remain intact.');
}

deleteAllRevenueEvents().then(() => {
  console.log('\nDone!');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

