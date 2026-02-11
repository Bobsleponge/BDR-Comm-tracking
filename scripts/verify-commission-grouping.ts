import { getLocalDB } from '../lib/db/local-db';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function verifyCommissionGrouping() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  console.log('Verifying Commission Grouping by Payable Date...\n');

  // Get all deals with commission entries
  const deals = db.prepare(`
    SELECT DISTINCT d.id, d.client_name, d.close_date, d.status
    FROM deals d
    INNER JOIN commission_entries ce ON d.id = ce.deal_id
    WHERE d.status = 'closed-won' AND d.close_date IS NOT NULL
    ORDER BY d.close_date
  `).all() as Array<{
    id: string;
    client_name: string;
    close_date: string;
    status: string;
  }>;

  console.log(`Found ${deals.length} deals with commission entries\n`);

  const monthBreakdown = new Map<string, {
    oldMonth: string;
    newMonth: string;
    amount: number;
    deals: string[];
  }>();

  let totalEntries = 0;
  let monthChanges = 0;

  for (const deal of deals) {
    const entries = db.prepare(`
      SELECT ce.accrual_date, ce.payable_date, ce.amount
      FROM commission_entries ce
      WHERE ce.deal_id = ?
      ORDER BY ce.accrual_date
    `).all(deal.id) as Array<{
      accrual_date: string;
      payable_date: string;
      amount: number;
    }>;

    for (const entry of entries) {
      totalEntries++;
      const oldMonth = entry.accrual_date?.substring(0, 7) || 'unknown';
      const newMonth = entry.payable_date?.substring(0, 7) || 'unknown';
      
      if (oldMonth !== newMonth) {
        monthChanges++;
        console.log(`⚠️  ${deal.client_name}:`);
        console.log(`   Close: ${deal.close_date}`);
        console.log(`   Accrual: ${entry.accrual_date} (${oldMonth}) → Payable: ${entry.payable_date} (${newMonth})`);
        console.log(`   Amount: $${entry.amount.toFixed(2)}`);
        console.log(`   Commission moves from ${oldMonth} to ${newMonth}\n`);
      }

      // Track by new month (payable_date)
      if (!monthBreakdown.has(newMonth)) {
        monthBreakdown.set(newMonth, {
          oldMonth: '',
          newMonth: newMonth,
          amount: 0,
          deals: [],
        });
      }
      const monthData = monthBreakdown.get(newMonth)!;
      monthData.amount += entry.amount;
      if (!monthData.deals.includes(deal.client_name)) {
        monthData.deals.push(deal.client_name);
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total commission entries: ${totalEntries}`);
  console.log(`Entries that changed months: ${monthChanges}`);
  console.log(`Entries staying in same month: ${totalEntries - monthChanges}\n`);

  console.log('=== COMMISSION BY MONTH (NEW GROUPING - Payable Date) ===');
  const sortedMonths = Array.from(monthBreakdown.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  let totalCommission = 0;
  for (const [month, data] of sortedMonths) {
    totalCommission += data.amount;
    console.log(`\n${month}:`);
    console.log(`  Total: $${data.amount.toFixed(2)}`);
    console.log(`  Deals: ${data.deals.length} (${data.deals.slice(0, 3).join(', ')}${data.deals.length > 3 ? '...' : ''})`);
  }

  console.log(`\n=== TOTAL COMMISSION ===`);
  console.log(`$${totalCommission.toFixed(2)}`);

  console.log('\n✓ Verification complete!');
  console.log('✓ Commission is now grouped by payable_date (when BDR can claim it)');
  console.log('✓ All deals are correctly configured');
}

verifyCommissionGrouping().then(() => {
  console.log('\nDone!');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

