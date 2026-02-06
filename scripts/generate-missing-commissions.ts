import { getLocalDB } from '../lib/db/local-db';
import { scheduleCommissionPayouts } from '../lib/commission/scheduler';

async function generateMissingCommissions() {
  const db = getLocalDB();
  
  // Find all closed-won deals with first_invoice_date that don't have commission entries
  const deals = db.prepare(`
    SELECT d.* 
    FROM deals d
    WHERE d.status = 'closed-won' 
      AND d.first_invoice_date IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM commission_entries ce WHERE ce.deal_id = d.id
      )
  `).all() as any[];

  console.log(`Found ${deals.length} deals without commission entries`);

  for (const deal of deals) {
    try {
      console.log(`Generating commission entries for deal: ${deal.id} (${deal.client_name})`);
      await scheduleCommissionPayouts(deal.id);
      console.log(`✓ Successfully generated commission entries for ${deal.client_name}`);
    } catch (error: any) {
      console.error(`✗ Error generating commission for ${deal.client_name}:`, error.message);
    }
  }

  console.log('Done!');
}

generateMissingCommissions().catch(console.error);

