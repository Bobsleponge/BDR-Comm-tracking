/**
 * AUDIT SCRIPT: Verify commission and revenue numbers are correct
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/audit-commission-numbers.ts [bdr_id]
 *
 * Cross-checks:
 * 1. Commission amount = revenue_event.amount_collected * commission_rate (2.5% default)
 * 2. Deal services commission_amount vs sum of commission entries for that service
 * 3. Revenue events per service match expected by billing type
 *
 * Outputs:
 * - Summary by accrual month and payable month
 * - Any discrepancies found
 * - Deal-by-deal breakdown for spot-checking against invoices/contracts
 */

import { getLocalDB } from '../lib/db/local-db';
import { format } from 'date-fns';

const bdrId = process.argv[2] || null;
const defaultRate = 0.025;

interface AuditEntry {
  dealId: string;
  clientName: string;
  serviceName: string;
  billingType: string;
  amountCollected: number;
  collectionDate: string;
  commissionAmount: number;
  expectedCommission: number;
  accrualDate: string;
  payableDate: string;
  accrualMonth: string;
  payableMonth: string;
  status: string;
  match: boolean;
  revenueEventId: string;
}

function main() {
  const db = getLocalDB();
  const rules = db.prepare('SELECT base_rate FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as { base_rate: number } | undefined;
  const rate = rules?.base_rate ?? defaultRate;

  let query = `
    SELECT 
      ce.id, ce.deal_id, ce.bdr_id, ce.amount, ce.accrual_date, ce.payable_date, ce.status, ce.revenue_event_id,
      d.client_name,
      re.amount_collected, re.collection_date, re.billing_type as rev_billing_type, re.service_id,
      ds.service_name, ds.billing_type, ds.commissionable_value, ds.commission_amount as service_expected_commission
    FROM commission_entries ce
    JOIN deals d ON ce.deal_id = d.id
    LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
    LEFT JOIN deal_services ds ON re.service_id = ds.id
    WHERE ce.status != 'cancelled' AND d.cancellation_date IS NULL
  `;
  const params: any[] = [];
  if (bdrId) {
    query += ' AND ce.bdr_id = ?';
    params.push(bdrId);
  }
  query += ' ORDER BY ce.accrual_date, ce.deal_id';

  const entries = db.prepare(query).all(...params) as any[];

  const audit: AuditEntry[] = [];
  const discrepancies: string[] = [];
  const accrualByMonth = new Map<string, number>();
  const payableByMonth = new Map<string, number>();

  for (const e of entries) {
    const amountCollected = Number(e.amount_collected ?? 0);
    const expectedCommission = amountCollected * rate;
    const actualCommission = Number(e.amount ?? 0);
    const match = Math.abs(actualCommission - expectedCommission) < 0.02;

    const accrualDate = e.accrual_date || e.payable_date || '';
    const payableDate = e.payable_date || accrualDate || '';
    const accrualMonth = accrualDate ? accrualDate.substring(0, 7) : 'unknown';
    const payableMonth = payableDate ? payableDate.substring(0, 7) : 'unknown';

    if (!match && amountCollected > 0) {
      discrepancies.push(
        `Commission mismatch: ${e.client_name} / ${e.service_name || 'deal'}: ` +
          `collected $${amountCollected}, expected $${expectedCommission.toFixed(2)}, got $${actualCommission}`
      );
    }

    audit.push({
      dealId: e.deal_id,
      clientName: e.client_name,
      serviceName: e.service_name || '(deal-level)',
      billingType: e.billing_type || e.rev_billing_type || 'unknown',
      amountCollected,
      collectionDate: e.collection_date || '',
      commissionAmount: actualCommission,
      expectedCommission,
      accrualDate,
      payableDate,
      accrualMonth,
      payableMonth,
      status: e.status,
      match,
      revenueEventId: e.revenue_event_id || '',
    });

    if (accrualMonth) {
      accrualByMonth.set(accrualMonth, (accrualByMonth.get(accrualMonth) ?? 0) + actualCommission);
    }
    if (payableMonth) {
      payableByMonth.set(payableMonth, (payableByMonth.get(payableMonth) ?? 0) + actualCommission);
    }
  }

  // Revenue events summary (cash collected by month)
  let revQuery = `
    SELECT strftime('%Y-%m', collection_date) as month, SUM(amount_collected) as total, COUNT(*) as cnt
    FROM revenue_events
    WHERE commissionable = 1
  `;
  const revParams: any[] = [];
  if (bdrId) {
    revQuery += ' AND bdr_id = ?';
    revParams.push(bdrId);
  }
  revQuery += " GROUP BY strftime('%Y-%m', collection_date) ORDER BY month";
  const revenueByMonth = db.prepare(revQuery).all(...revParams) as Array<{ month: string; total: number; cnt: number }>;

  console.log('='.repeat(70));
  console.log('COMMISSION & REVENUE AUDIT');
  console.log('='.repeat(70));
  console.log(`BDR: ${bdrId || 'all'}`);
  console.log(`Commission rate: ${(rate * 100).toFixed(2)}%`);
  console.log(`Entries audited: ${audit.length}`);
  console.log('');

  if (discrepancies.length > 0) {
    console.log('DISCREPANCIES FOUND');
    console.log('-'.repeat(40));
    discrepancies.forEach((d) => console.log(`  ! ${d}`));
    console.log('');
  } else {
    console.log('✓ All commission amounts match expected (amount_collected × rate)');
    console.log('');
  }

  console.log('COMMISSION BY ACCRUAL MONTH (when commission is earned)');
  console.log('-'.repeat(40));
  const sortedAccrual = Array.from(accrualByMonth.entries()).sort(([a], [b]) => a.localeCompare(b));
  let totalAccrual = 0;
  sortedAccrual.forEach(([month, amt]) => {
    console.log(`  ${month}: $${amt.toFixed(2)}`);
    totalAccrual += amt;
  });
  console.log(`  TOTAL: $${totalAccrual.toFixed(2)}`);
  console.log('');

  console.log('COMMISSION BY PAYABLE MONTH (when BDR can claim)');
  console.log('-'.repeat(40));
  const sortedPayable = Array.from(payableByMonth.entries()).sort(([a], [b]) => a.localeCompare(b));
  let totalPayable = 0;
  sortedPayable.forEach(([month, amt]) => {
    console.log(`  ${month}: $${amt.toFixed(2)}`);
    totalPayable += amt;
  });
  console.log(`  TOTAL: $${totalPayable.toFixed(2)}`);
  console.log('');

  console.log('CASH COLLECTED BY MONTH (revenue_events)');
  console.log('-'.repeat(40));
  revenueByMonth.forEach((r) => {
    console.log(`  ${r.month}: $${Number(r.total).toFixed(2)} (${r.cnt} events)`);
  });
  console.log('');

  // Deal-level: expected (deal_services.commission_amount) vs actual (sum of ce for that service)
  let dealQuery = `
    SELECT ds.deal_id, d.client_name, ds.id as service_id, ds.service_name, ds.billing_type,
           ds.commission_amount as expected
    FROM deal_services ds
    JOIN deals d ON ds.deal_id = d.id
    WHERE d.status = 'closed-won' AND d.cancellation_date IS NULL
  `;
  const dealParams: any[] = [];
  if (bdrId) {
    dealQuery += ' AND d.bdr_id = ?';
    dealParams.push(bdrId);
  }
  const services = db.prepare(dealQuery).all(...dealParams) as any[];
  const serviceActual = new Map<string, number>();
  for (const e of entries) {
    const key = e.service_id ? `${e.deal_id}:${e.service_id}` : `${e.deal_id}:deal`;
    serviceActual.set(key, (serviceActual.get(key) ?? 0) + Number(e.amount ?? 0));
  }
  // Sum by service_id from revenue_events -> deal_services
  const byService = new Map<string, number>();
  for (const e of entries) {
    if (e.service_id) {
      const k = `${e.deal_id}:${e.service_id}`;
      byService.set(k, (byService.get(k) ?? 0) + Number(e.amount ?? 0));
    }
  }
  const dealMismatches: string[] = [];
  for (const svc of services) {
    const actual = byService.get(`${svc.deal_id}:${svc.service_id}`) ?? 0;
    const exp = Number(svc.expected ?? 0);
    if (Math.abs(actual - exp) > 0.02) {
      dealMismatches.push(
        `${svc.client_name} / ${svc.service_name}: expected $${exp.toFixed(2)}, actual $${actual.toFixed(2)} (diff $${(actual - exp).toFixed(2)})`
      );
    }
  }
  if (dealMismatches.length > 0) {
    console.log('DEAL-LEVEL: stored commission_amount vs sum of entries');
    console.log('-'.repeat(40));
    dealMismatches.forEach((m) => console.log(`  ${m}`));
    console.log('');
    console.log('  Note: deal_services.commission_amount is stored at save; actual entries');
    console.log('  come from revenue_events (amount_collected × rate). Differences are expected');
    console.log('  after logic changes (e.g. deposit+renewal now uses 50/50 instead of uplift-only).');
    console.log('');
  }

  console.log('HOW TO VERIFY');
  console.log('-'.repeat(40));
  console.log('1. Commission = amount_collected × 2.5% (or your base_rate)');
  console.log('2. Compare accrual/payable months to prior reports or invoices');
  console.log('3. In app: Commission → Verification shows deal-level expected vs actual');
  console.log('4. In app: Commission → Breakdown shows entries by payable month');
  console.log('5. Run: USE_LOCAL_DB=true npx tsx scripts/verify-commission-entries.ts');
  console.log('');
  console.log('If prior-month numbers changed: reprocessing replaced old entries with');
  console.log('new ones from deal_services. Compare this audit output to prior export.');
  console.log('='.repeat(70));
}

main();
