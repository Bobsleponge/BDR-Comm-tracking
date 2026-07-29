/**
 * Full deal/service commission structure verification.
 * Run: USE_LOCAL_DB=true npx tsx scripts/verify-deal-structure.ts
 */

import { getLocalDB } from '../lib/db/local-db';

function expectedCount(service: {
  billing_type: string;
  completion_date: string | null;
  contract_months: number | null;
  contract_quarters: number | null;
  is_renewal: number | boolean;
}): number {
  const bt = (service.billing_type || '').toLowerCase();
  if (service.is_renewal === 1 || service.is_renewal === true) return 1;
  if (bt === 'deposit') return service.completion_date ? 2 : 1;
  if (bt === 'one_off' || bt === 'renewal' || bt === 'paid_on_completion') return 1;
  if (bt === 'mrr') return service.contract_months ?? 12;
  if (bt === 'quarterly') return service.contract_quarters ?? 4;
  return 1;
}

function main() {
  const db = getLocalDB();
  const rate =
    (db.prepare('SELECT base_rate FROM commission_rules ORDER BY updated_at DESC LIMIT 1').get() as
      | { base_rate: number }
      | undefined)?.base_rate ?? 0.025;

  const deals = db
    .prepare(
      `SELECT id, client_name, first_invoice_date, cancellation_date, updated_at
       FROM deals WHERE status = 'closed-won' ORDER BY client_name`
    )
    .all() as Array<{
    id: string;
    client_name: string;
    first_invoice_date: string | null;
    cancellation_date: string | null;
    updated_at: string;
  }>;

  let trulyOk = 0;
  let linkOnly = 0;
  let structural = 0;
  let cancelled = 0;
  const okDeals: string[] = [];
  const linkDeals: string[] = [];
  const structuralIssues: Array<{ client: string; service: string; issue: string }> = [];

  for (const deal of deals) {
    if (deal.cancellation_date) {
      cancelled++;
      continue;
    }
    if (!deal.first_invoice_date) {
      structural++;
      structuralIssues.push({ client: deal.client_name, service: '(deal)', issue: 'missing first_invoice_date' });
      continue;
    }

    const services = db.prepare('SELECT * FROM deal_services WHERE deal_id = ?').all(deal.id) as any[];
    if (services.length === 0) {
      structural++;
      structuralIssues.push({ client: deal.client_name, service: '(none)', issue: 'no services' });
      continue;
    }

    let dealOk = true;
    let dealNeedsLink = false;

    const seenServiceKeys = new Map<string, number>();
    for (const s of services) {
      const key = `${String(s.service_name).trim().toLowerCase()}|${s.billing_type}|${Number(s.commissionable_value).toFixed(2)}`;
      seenServiceKeys.set(key, (seenServiceKeys.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seenServiceKeys) {
      if (count > 1) {
        dealOk = false;
        structural++;
        const [name] = key.split('|');
        structuralIssues.push({
          client: deal.client_name,
          service: name,
          issue: `duplicate service on deal (${count}x) — causes duplicate commission entries`,
        });
      }
    }

    for (const s of services) {
      let expN = expectedCount(s);
      const revs = db
        .prepare(
          `SELECT id, amount_collected FROM revenue_events
           WHERE deal_id = ? AND service_id = ? AND commissionable = 1`
        )
        .all(deal.id, s.id) as Array<{ id: string; amount_collected: number }>;
      if (s.is_renewal === 1 || revs.some((r) => false)) {
        if (s.is_renewal === 1) expN = 1;
      }

      const ces = db
        .prepare(
          `SELECT id, revenue_event_id, amount FROM commission_entries
           WHERE deal_id = ? AND status != 'cancelled'
             AND (service_id = ? OR revenue_event_id IN (SELECT id FROM revenue_events WHERE service_id = ?))`
        )
        .all(deal.id, s.id, s.id) as Array<{ id: string; revenue_event_id: string | null; amount: number }>;

      const revLinked = revs.filter((r) =>
        db.prepare('SELECT 1 FROM commission_entries WHERE revenue_event_id = ?').get(r.id)
      ).length;
      const unlinked = ces.filter((c) => !c.revenue_event_id).length;
      const revSum = revs.reduce((a, r) => a + Number(r.amount_collected), 0);
      const ceSum = ces.reduce((a, c) => a + Number(c.amount), 0);

      if (revs.length === 0) {
        dealOk = false;
        structural++;
        structuralIssues.push({
          client: deal.client_name,
          service: s.service_name,
          issue: 'no revenue events',
        });
        continue;
      }

      const isRenewal = s.is_renewal === 1 || s.is_renewal === true;
      if (s.billing_type === 'deposit' && s.completion_date && !isRenewal && revs.length < 2) {
        dealOk = false;
        structural++;
        structuralIssues.push({
          client: deal.client_name,
          service: s.service_name,
          issue: `deposit missing 2nd revenue event (have ${revs.length}/2)`,
        });
      }

      if (ces.length !== expN) {
        dealOk = false;
        structural++;
        structuralIssues.push({
          client: deal.client_name,
          service: s.service_name,
          issue: `expected ${expN} CE, have ${ces.length}`,
        });
        continue;
      }

      if (Math.abs(ceSum - revSum * rate) > 0.05) {
        dealOk = false;
        structural++;
        structuralIssues.push({
          client: deal.client_name,
          service: s.service_name,
          issue: `amount sum $${ceSum.toFixed(2)} != rev×rate $${(revSum * rate).toFixed(2)}`,
        });
      }

      if (revLinked < expN || unlinked > 0) {
        dealNeedsLink = true;
        linkOnly++;
      }
    }

    if (dealOk && !dealNeedsLink) {
      trulyOk++;
      okDeals.push(deal.client_name);
    } else if (dealOk && dealNeedsLink) {
      linkDeals.push(deal.client_name);
    }
  }

  const dupCe = db
    .prepare(
      `SELECT d.client_name, ds.service_name, substr(ce.payable_date,1,7) m, COUNT(*) c
       FROM commission_entries ce
       JOIN deals d ON ce.deal_id = d.id
       LEFT JOIN deal_services ds ON ce.service_id = ds.id
       WHERE ce.status != 'cancelled' AND d.cancellation_date IS NULL
       GROUP BY ce.deal_id, ce.service_id, substr(ce.payable_date,1,7)
       HAVING c > 1`
    )
    .all() as Array<{ client_name: string; service_name: string; m: string; c: number }>;

  const orphanRe = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM revenue_events re
         JOIN deals d ON d.id = re.deal_id
         WHERE d.status = 'closed-won' AND d.cancellation_date IS NULL AND re.commissionable = 1
           AND NOT EXISTS (SELECT 1 FROM commission_entries ce WHERE ce.revenue_event_id = re.id)`
      )
      .get() as { c: number }
  ).c;

  const unlinkedCe = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM commission_entries ce
         JOIN deals d ON ce.deal_id = d.id
         WHERE d.status = 'closed-won' AND d.cancellation_date IS NULL
           AND ce.status != 'cancelled' AND ce.revenue_event_id IS NULL`
      )
      .get() as { c: number }
  ).c;

  console.log('='.repeat(72));
  console.log('DEAL / SERVICE COMMISSION STRUCTURE VERIFICATION');
  console.log('='.repeat(72));
  console.log('');
  console.log('SUMMARY');
  console.log('-'.repeat(40));
  console.log(`Closed-won deals:              ${deals.length}`);
  console.log(`Cancelled (skipped):           ${cancelled}`);
  console.log(`Truly OK (count + linked):     ${trulyOk}`);
  console.log(`OK count, needs re-link:       ${linkDeals.length} deals (${linkOnly} services)`);
  console.log(`Structural issues:             ${structuralIssues.length}`);
  console.log(`Unlinked commission entries:   ${unlinkedCe}`);
  console.log(`Revenue events without CE:     ${orphanRe}`);
  console.log(`Duplicate CE (deal/svc/month): ${dupCe.length} groups`);
  console.log(`Amount mismatches (linked):    ${
    (
      db
        .prepare(
          `SELECT COUNT(*) c FROM commission_entries ce
           JOIN revenue_events re ON ce.revenue_event_id = re.id
           WHERE ce.status != 'cancelled'
             AND abs(ce.amount - re.amount_collected * ?) > 0.02`
        )
        .get(rate) as { c: number }
    ).c
  }`);
  console.log('');

  if (okDeals.length) {
    console.log('FULLY VERIFIED DEALS');
    console.log('-'.repeat(40));
    okDeals.forEach((n) => console.log(`  ✓ ${n}`));
    console.log('');
  }

  if (structuralIssues.length) {
    console.log('STRUCTURAL ISSUES (need fix beyond re-link)');
    console.log('-'.repeat(40));
    structuralIssues.forEach((i) => console.log(`  ! ${i.client} / ${i.service}: ${i.issue}`));
    console.log('');
  }

  if (dupCe.length) {
    console.log('DUPLICATE ENTRIES (same deal + service + payable month)');
    console.log('-'.repeat(40));
    dupCe.forEach((d) =>
      console.log(`  ! ${d.client_name} / ${d.service_name} ${d.m}: ${d.c} entries`)
    );
    console.log('');
  }

  console.log('LINK-ONLY DEALS (entry count & amounts OK; revenue_event_id not wired)');
  console.log(`Total: ${linkDeals.length} — run safe reprocess to re-link`);
  console.log('-'.repeat(40));
  [...new Set(linkDeals)].slice(0, 20).forEach((n) => console.log(`  ~ ${n}`));
  if (linkDeals.length > 20) console.log(`  ... and ${linkDeals.length - 20} more`);
  console.log('');
  console.log('='.repeat(72));
}

main();
