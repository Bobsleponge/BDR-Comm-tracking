import { getLocalDB } from '../lib/db/local-db';
import { createRevenueEventsForDeal, processRevenueEvent } from '../lib/commission/revenue-events';

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
      
      // Create revenue events for the deal
      await createRevenueEventsForDeal(deal.id);
      
      // Process revenue events that have been collected (collection_date <= today)
      const today = new Date().toISOString().split('T')[0];
      const revenueEvents = db.prepare(`
        SELECT id FROM revenue_events 
        WHERE deal_id = ? AND collection_date <= ?
      `).all(deal.id, today) as Array<{ id: string }>;
      
      let processedCount = 0;
      for (const event of revenueEvents) {
        try {
          await processRevenueEvent(event.id);
          processedCount++;
        } catch (error: any) {
          console.error(`  Error processing revenue event ${event.id}:`, error.message);
        }
      }
      
      console.log(`✓ Successfully generated ${processedCount} commission entries for ${deal.client_name}`);
    } catch (error: any) {
      console.error(`✗ Error generating commission for ${deal.client_name}:`, error.message);
    }
  }

  console.log('Done!');
}

generateMissingCommissions().catch(console.error);



