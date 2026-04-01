/**
 * VERIFICATION SCRIPT: Commission Entries Per Deal
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/verify-commission-entries.ts
 *
 * Verifies that every aspect of every deal has a corresponding commission entry:
 * - For each closed-won deal
 * - For each service on that deal
 * - For each revenue event (from that service)
 * - There must be a commission entry linked via revenue_event_id
 *
 * Also checks for:
 * - Services with no revenue events (missing events)
 * - Revenue events with no commission entry (missing entries)
 * - Deals with no services
 */

import { getLocalDB } from '../lib/db/local-db';

interface DealRow {
  id: string;
  client_name: string;
  close_date: string;
  bdr_id: string;
  first_invoice_date: string | null;
  status: string;
  is_renewal?: number | boolean;
  original_deal_value?: number | null;
}

interface ServiceRow {
  id: string;
  service_name: string;
  billing_type: string;
  commissionable_value: number;
  commission_amount: number;
  contract_months: number;
  contract_quarters: number;
  completion_date: string | null;
  is_renewal: number;
}

interface RevenueEventRow {
  id: string;
  amount_collected: number;
  collection_date: string;
  payment_stage: string;
  billing_type: string;
  commissionable: number;
}

interface CommissionEntryRow {
  id: string;
  revenue_event_id: string | null;
  amount: number;
}

interface Issue {
  type: 'no_services' | 'no_revenue_events' | 'revenue_event_no_commission' | 'summary' | 'count_mismatch_detail';
  dealId: string;
  clientName: string;
  serviceId?: string;
  serviceName?: string;
  billingType?: string;
  revenueEventId?: string;
  collectionDate?: string;
  amountCollected?: number;
  expectedEntries?: number;
  actualEntries?: number;
  revenueEventCount?: number;
  commissionEntryCount?: number;
  message: string;
}

function main() {
  const db = getLocalDB();

  const deals = db.prepare(`
    SELECT id, client_name, close_date, bdr_id, first_invoice_date, status, is_renewal, original_deal_value
    FROM deals
    WHERE status = 'closed-won'
      AND cancellation_date IS NULL
    ORDER BY close_date
  `).all() as DealRow[];

  const issues: Issue[] = [];
  let totalDealsChecked = 0;
  let totalServicesChecked = 0;
  let totalRevenueEventsChecked = 0;
  let totalCommissionEntriesLinked = 0;
  let missingCommissionEntries = 0;
  let servicesWithNoRevenueEvents = 0;

  for (const deal of deals) {
    totalDealsChecked++;

    const services = db.prepare(`
      SELECT id, service_name, billing_type, commissionable_value, commission_amount,
             contract_months, contract_quarters, completion_date, is_renewal
      FROM deal_services
      WHERE deal_id = ?
    `).all(deal.id) as ServiceRow[];

    if (services.length === 0) {
      issues.push({
        type: 'no_services',
        dealId: deal.id,
        clientName: deal.client_name,
        message: `Deal has no services`,
      });
      continue;
    }

    for (const service of services) {
      totalServicesChecked++;

      const revenueEvents = db.prepare(`
        SELECT id, amount_collected, collection_date, payment_stage, billing_type, commissionable
        FROM revenue_events
        WHERE deal_id = ? AND service_id = ?
        ORDER BY collection_date
      `).all(deal.id, service.id) as RevenueEventRow[];

      if (revenueEvents.length === 0) {
        servicesWithNoRevenueEvents++;
        issues.push({
          type: 'no_revenue_events',
          dealId: deal.id,
          clientName: deal.client_name,
          serviceId: service.id,
          serviceName: service.service_name,
          billingType: service.billing_type,
          message: `Service "${service.service_name}" (${service.billing_type}) has NO revenue events`,
        });
        continue;
      }

      const expectedCount = getExpectedEntryCount(service, deal);
      let actualCount = 0;
      const commissionableEvents = revenueEvents.filter((re) => re.commissionable === 1 || re.commissionable === true);

      for (const re of commissionableEvents) {
        totalRevenueEventsChecked++;

        const ce = db.prepare(`
          SELECT id, revenue_event_id, amount
          FROM commission_entries
          WHERE revenue_event_id = ?
        `).get(re.id) as CommissionEntryRow | undefined;

        if (ce) {
          totalCommissionEntriesLinked++;
          actualCount++;
        } else {
          missingCommissionEntries++;
          issues.push({
            type: 'revenue_event_no_commission',
            dealId: deal.id,
            clientName: deal.client_name,
            serviceId: service.id,
            serviceName: service.service_name,
            billingType: service.billing_type,
            revenueEventId: re.id,
            collectionDate: re.collection_date,
            amountCollected: re.amount_collected,
            message: `Revenue event ${re.id} ($${re.amount_collected} on ${re.collection_date}) has NO commission entry`,
          });
        }
      }

      if (actualCount !== expectedCount && revenueEvents.length > 0) {
        issues.push({
          type: 'count_mismatch_detail',
          dealId: deal.id,
          clientName: deal.client_name,
          serviceId: service.id,
          serviceName: service.service_name,
          billingType: service.billing_type,
          expectedEntries: expectedCount,
          actualEntries: actualCount,
          revenueEventCount: commissionableEvents.length,
          commissionEntryCount: actualCount,
          message: `Service "${service.service_name}" (${service.billing_type}): expected ${expectedCount} entries, have ${commissionableEvents.length} revenue events, ${actualCount} have commission entries. completion_date=${service.completion_date ?? 'null'}`,
        });
      }
    }
  }

  // Report
  console.log('='.repeat(80));
  console.log('COMMISSION ENTRIES VERIFICATION REPORT');
  console.log('='.repeat(80));
  console.log('');
  console.log('SUMMARY');
  console.log('-'.repeat(40));
  console.log(`Closed-won deals checked:       ${totalDealsChecked}`);
  console.log(`Services checked:              ${totalServicesChecked}`);
  console.log(`Revenue events (commissionable): ${totalRevenueEventsChecked}`);
  console.log(`Commission entries linked:     ${totalCommissionEntriesLinked}`);
  console.log(`Missing commission entries:    ${missingCommissionEntries}`);
  console.log(`Services with no rev events:   ${servicesWithNoRevenueEvents}`);
  console.log('');

  if (issues.length > 0) {
    console.log('ISSUES FOUND');
    console.log('-'.repeat(40));

    const byType = (t: Issue['type']) => issues.filter((i) => i.type === t);
    if (byType('no_services').length > 0) {
      console.log('\n  [Deals with no services]');
      byType('no_services').forEach((i) => console.log(`    - ${i.clientName} (${i.dealId}): ${i.message}`));
    }
    if (byType('no_revenue_events').length > 0) {
      console.log('\n  [Services with no revenue events - need createRevenueEventsForDeal + processRevenueEvent]');
      byType('no_revenue_events').forEach((i) =>
        console.log(`    - ${i.clientName} / ${i.serviceName} (${i.billingType})`)
      );
      console.log(`    Total: ${byType('no_revenue_events').length} services`);
    }
    if (byType('revenue_event_no_commission').length > 0) {
      console.log('\n  [Revenue events without commission entries - need processRevenueEvent]');
      byType('revenue_event_no_commission').forEach((i) =>
        console.log(`    - ${i.clientName} / ${i.serviceName}: $${i.amountCollected} on ${i.collectionDate} (event ${i.revenueEventId})`)
      );
    }
    if (byType('count_mismatch_detail').length > 0) {
      console.log('\n  [Entry count mismatches - root cause analysis]');
      byType('count_mismatch_detail').forEach((i) => console.log(`    - ${i.message}`));
    }
  } else {
    console.log('All deals verified: every revenue event has a commission entry.');
  }

  console.log('');
  console.log('='.repeat(80));
}

function getExpectedEntryCount(service: ServiceRow, deal?: { is_renewal?: number | boolean; original_deal_value?: number | null }): number {
  const bt = (service.billing_type || '').toLowerCase();
  // Deposit and paid_on_completion use payment structure regardless of renewal
  if (bt === 'deposit') return service.completion_date ? 2 : 1;
  if (bt === 'paid_on_completion') return 1;
  const isRenewal =
    service.is_renewal === 1 ||
    service.is_renewal === true ||
    (deal && (deal.is_renewal === 1 || deal.is_renewal === true) && Number(deal.original_deal_value ?? 0) > 0);
  if (isRenewal) return 1; // Renewal (one_off/mrr/quarterly): one-time uplift only
  if (bt === 'one_off' || bt === 'renewal') return 1;
  if (bt === 'mrr') return service.contract_months ?? 12;
  if (bt === 'quarterly') return service.contract_quarters ?? 4;
  return 1;
}

main();
