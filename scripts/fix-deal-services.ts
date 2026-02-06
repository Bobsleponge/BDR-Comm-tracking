import { getLocalDB } from '../lib/db/local-db';
import { calculateServiceCommission } from '../lib/commission/calculator';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function fixDealServices(dealId: string) {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  // Get deal info
  const deal = db.prepare('SELECT * FROM deals WHERE id = ?').get(dealId) as any;
  if (!deal) {
    console.error(`Deal ${dealId} not found`);
    process.exit(1);
  }

  console.log(`Fixing services for deal: ${deal.client_name} (${deal.id})\n`);

  // Get commission rules for base rate
  const rules = db.prepare('SELECT * FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as any;
  const baseRate = rules?.base_rate ?? 0.025;

  // Get existing services
  const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(dealId) as any[];

  console.log('Current services:');
  services.forEach(s => {
    console.log(`  - ${s.service_name}: ${s.billing_type}, unit_price=${s.unit_price}, quarterly_price=${s.quarterly_price}`);
  });

  // Update one-off service to $6,000
  const oneOffService = services.find(s => s.billing_type === 'one_off');
  if (oneOffService) {
    const unitPrice = 6000;
    const quantity = 1;
    
    const commission = calculateServiceCommission(
      'one_off',
      unitPrice,
      null,
      null,
      quantity,
      12,
      4,
      null,
      baseRate
    );

    db.prepare(`
      UPDATE deal_services
      SET unit_price = ?,
          commissionable_value = ?,
          commission_amount = ?
      WHERE id = ?
    `).run(
      unitPrice,
      commission.commissionable_value,
      commission.commission_amount,
      oneOffService.id
    );

    console.log(`\n✓ Updated one-off service: $${unitPrice} (commission: $${commission.commission_amount})`);
  } else {
    console.log('\n✗ One-off service not found');
  }

  // Update quarterly service to $1,000 per quarter
  const quarterlyService = services.find(s => s.billing_type === 'quarterly');
  if (quarterlyService) {
    const quarterlyPrice = 1000;
    const contractQuarters = 4;
    const quantity = 1;
    
    const commission = calculateServiceCommission(
      'quarterly',
      0,
      null,
      quarterlyPrice,
      quantity,
      12,
      contractQuarters,
      null,
      baseRate
    );

    db.prepare(`
      UPDATE deal_services
      SET quarterly_price = ?,
          contract_quarters = ?,
          commissionable_value = ?,
          commission_amount = ?
      WHERE id = ?
    `).run(
      quarterlyPrice,
      contractQuarters,
      commission.commissionable_value,
      commission.commission_amount,
      quarterlyService.id
    );

    console.log(`✓ Updated quarterly service: $${quarterlyPrice} per quarter for ${contractQuarters} quarters (commission per quarter: $${(quarterlyPrice * baseRate).toFixed(2)})`);
  } else {
    console.log('\n✗ Quarterly service not found');
  }

  console.log('\n✓ Services updated!');
}

// Get deal ID from command line
const dealId = process.argv[2] || 'd5298566-7368-403e-848c-d2a4e25d9bf7';

fixDealServices(dealId).then(() => {
  console.log('\nDone! Now run the reprocess script to recreate revenue events.');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

