/**
 * Verify that every entry in today's report(s) has not yet been paid
 * (i.e. does not appear in any approved/paid commission batch).
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/verify-report-not-paid.ts
 */

import { getLocalDB } from '../lib/db/local-db';

const today = new Date().toISOString().split('T')[0];

function main() {
  const db = getLocalDB();

  // Find batches from today (any status - we'll check each)
  const batches = db.prepare(`
    SELECT id, bdr_id, run_date, status
    FROM commission_batches
    WHERE run_date = ?
    ORDER BY created_at DESC
  `).all(today) as Array<{ id: string; bdr_id: string; run_date: string; status: string }>;

  if (batches.length === 0) {
    console.log(`No commission batches found for today (${today}).`);
    return;
  }

  console.log(`\nBatches for ${today}:\n`);

  for (const batch of batches) {
    const items = db.prepare(`
      SELECT cbi.commission_entry_id, ce.deal_id, ce.payable_date, ce.accrual_date, ce.month, ce.amount, d.client_name
      FROM commission_batch_items cbi
      JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
      JOIN deals d ON ce.deal_id = d.id
      WHERE cbi.batch_id = ?
    `).all(batch.id) as Array<{
      commission_entry_id: string;
      deal_id: string;
      payable_date: string | null;
      accrual_date: string | null;
      month: string | null;
      amount: number;
      client_name: string;
    }>;

    console.log(`  Batch ${batch.id.slice(0, 8)}... (${batch.status}) - ${items.length} entries`);

    const violations: Array<{ entryId: string; client: string; reason: string }> = [];

    for (const item of items) {
      const { commission_entry_id, deal_id, payable_date, accrual_date, month, amount, client_name } = item;
      const effectiveDate = payable_date || accrual_date || (month ? `${month}-01` : null);

      // Check 1: Is this entry in ANY other approved/paid batch?
      const inOtherApproved = db.prepare(`
        SELECT cb.id, cb.status
        FROM commission_batch_items cbi
        JOIN commission_batches cb ON cbi.batch_id = cb.id
        WHERE cbi.commission_entry_id = ?
          AND cb.id != ?
          AND cb.status IN ('approved', 'paid')
        LIMIT 1
      `).get(commission_entry_id, batch.id) as { id: string; status: string } | undefined;

      if (inOtherApproved) {
        violations.push({
          entryId: commission_entry_id.slice(0, 8),
          client: client_name,
          reason: `Entry already in approved/paid batch ${inOtherApproved.id.slice(0, 8)}...`,
        });
        continue;
      }

      // Check 2: Does this entry match an approved_commission_fingerprint? (match by deal+month)
      const monthKey = effectiveDate ? String(effectiveDate).slice(0, 7) : null;
      const matchesFingerprint = monthKey ? db.prepare(`
        SELECT acf.batch_id
        FROM approved_commission_fingerprints acf
        WHERE acf.bdr_id = ?
          AND acf.deal_id = ?
          AND substr(acf.effective_date, 1, 7) = ?
        LIMIT 1
      `).get(batch.bdr_id, deal_id, monthKey) as { batch_id: string } | undefined : undefined;

      if (matchesFingerprint) {
        violations.push({
          entryId: commission_entry_id.slice(0, 8),
          client: client_name,
          reason: `Matches approved fingerprint (batch ${matchesFingerprint.batch_id.slice(0, 8)}...)`,
        });
      }
    }

    if (violations.length === 0) {
      console.log(`    ✓ All ${items.length} entries have NOT been paid (no duplicates found)\n`);
    } else {
      console.log(`    ✗ ${violations.length} entry/entries ALREADY PAID in another report:\n`);
      for (const v of violations) {
        console.log(`      - ${v.client} (${v.entryId}...): ${v.reason}`);
      }
      console.log('');
    }
  }

  console.log('Done.\n');
}

main();
