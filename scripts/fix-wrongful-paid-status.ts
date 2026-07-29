/**
 * Reset commission entries wrongly marked paid by the blanket month-lock bug.
 * Only entries matching a PAID-batch fingerprint (exact month + amount) stay paid.
 *
 * Run: USE_LOCAL_DB=true npx tsx scripts/fix-wrongful-paid-status.ts
 */

import Module from 'node:module';

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { getLocalDB } = await import('../lib/db/local-db');
  const { amountsMatch, dedupeFingerprints } = await import('../lib/commission/approval-lock');
  const db = getLocalDB();

  const fpRows = db.prepare(`
    SELECT acf.bdr_id, acf.deal_id, acf.effective_date, acf.amount, acf.batch_id, cb.status as batch_status
    FROM approved_commission_fingerprints acf
    JOIN commission_batches cb ON cb.id = acf.batch_id
    WHERE cb.status = 'paid'
  `).all() as any[];

  const paidLocks = dedupeFingerprints(fpRows);

  const paidEntries = db.prepare(`
    SELECT ce.id, ce.deal_id, ce.amount, ce.payable_date, ce.accrual_date, ce.month, d.client_name
    FROM commission_entries ce
    JOIN deals d ON d.id = ce.deal_id
    WHERE ce.status = 'paid'
  `).all() as any[];

  const update = db.prepare(`UPDATE commission_entries SET status = 'accrued', updated_at = datetime('now') WHERE id = ?`);

  let reset = 0;
  let kept = 0;

  for (const entry of paidEntries) {
    const month = (entry.payable_date || entry.accrual_date || `${entry.month}-01`).slice(0, 7);
    const legit = paidLocks.some(
      (l) =>
        l.dealId === entry.deal_id &&
        l.month === month &&
        amountsMatch(l.amount, entry.amount)
    );

    if (legit) {
      kept++;
    } else {
      update.run(entry.id);
      reset++;
      console.log(`Reset to accrued: ${entry.client_name} ${month} $${entry.amount}`);
    }
  }

  console.log(`\nKept ${kept} legitimately paid entries, reset ${reset} wrongful paid entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
