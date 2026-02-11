/**
 * Script to update existing renewal deals/services
 * Marks services as renewals and sets original_service_value based on deal's original_deal_value
 */

import { getLocalDB } from '../lib/db/local-db';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

async function updateRenewalServices() {
  if (!USE_LOCAL_DB) {
    console.error('This script only works with local database');
    process.exit(1);
  }

  const db = getLocalDB();

  console.log('Updating renewal services...\n');

  // Get all renewal deals
  const renewalDeals = db.prepare(`
    SELECT id, client_name, deal_value, original_deal_value, is_renewal
    FROM deals
    WHERE is_renewal = 1
    ORDER BY client_name
  `).all() as Array<{
    id: string;
    client_name: string;
    deal_value: number;
    original_deal_value: number | null;
    is_renewal: number;
  }>;

  console.log(`Found ${renewalDeals.length} renewal deal(s)\n`);

  let updatedServices = 0;
  let skippedDeals = 0;

  for (const deal of renewalDeals) {
    console.log(`Processing: ${deal.client_name} (${deal.id})`);
    console.log(`  Deal Value: $${deal.deal_value.toFixed(2)}`);
    console.log(`  Original Deal Value: $${(deal.original_deal_value || 0).toFixed(2)}`);

    if (!deal.original_deal_value) {
      console.log(`  ⚠️  Skipping - no original_deal_value set\n`);
      skippedDeals++;
      continue;
    }

    // Get all services for this deal
    const services = db.prepare(`
      SELECT id, service_name, commissionable_value, is_renewal, original_service_value
      FROM deal_services
      WHERE deal_id = ?
    `).all(deal.id) as Array<{
      id: string;
      service_name: string;
      commissionable_value: number;
      is_renewal: number;
      original_service_value: number | null;
    }>;

    if (services.length === 0) {
      console.log(`  ⚠️  No services found\n`);
      skippedDeals++;
      continue;
    }

    console.log(`  Found ${services.length} service(s)`);

    // Calculate original service values
    const totalCurrentValue = services.reduce((sum, s) => sum + Number(s.commissionable_value || 0), 0);
    const originalDealValue = Number(deal.original_deal_value);

    for (const service of services) {
      const currentValue = Number(service.commissionable_value || 0);
      
      // Calculate original service value proportionally
      // If only one service, use the full original_deal_value
      // If multiple services, allocate proportionally based on current values
      let originalServiceValue: number;
      if (services.length === 1) {
        originalServiceValue = originalDealValue;
      } else {
        // Allocate proportionally
        const proportion = totalCurrentValue > 0 ? currentValue / totalCurrentValue : 0;
        originalServiceValue = originalDealValue * proportion;
      }

      const uplift = Math.max(0, currentValue - originalServiceValue);
      
      console.log(`    - ${service.service_name}:`);
      console.log(`      Current: $${currentValue.toFixed(2)}`);
      console.log(`      Original: $${originalServiceValue.toFixed(2)}`);
      console.log(`      Uplift: $${uplift.toFixed(2)}`);
      console.log(`      Expected Commission (2.5%): $${(uplift * 0.025).toFixed(2)}`);

      // Update the service
      db.prepare(`
        UPDATE deal_services
        SET is_renewal = 1,
            original_service_value = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(originalServiceValue, service.id);

      updatedServices++;
      console.log(`      ✅ Updated\n`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total renewal deals: ${renewalDeals.length}`);
  console.log(`Services updated: ${updatedServices}`);
  console.log(`Deals skipped: ${skippedDeals}`);
  console.log('\n✅ Update complete!');
  console.log('\nNext step: Run rebuild-all-commissions.ts to regenerate commission entries with correct calculations.');
}

updateRenewalServices()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nFatal error:', error);
    process.exit(1);
  });

