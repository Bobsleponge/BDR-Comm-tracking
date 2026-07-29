import { describe, it, expect } from 'vitest';
import { parseCommissionReportBuffer } from '@/lib/commission/import-update/parse-file';
import { matchBossRowsToBatchItems } from '@/lib/commission/import-update/match-rows';
import { diffBossRowAgainstCurrent } from '@/lib/commission/import-update/diff-rows';
import type { BatchItemForImport, ParsedImportRow } from '@/lib/commission/import-update/types';

function makeBossRow(overrides: Partial<ParsedImportRow> = {}): ParsedImportRow {
  return {
    sourceRowIndex: 1,
    client_name: 'Acme Corp',
    deal: 'SEO Retainer',
    payment_sequence: '1 of 12',
    payable_date: '2026-02-15',
    amount_claimed_on: '5000.00',
    is_renewal: 'No',
    previous_deal_amount: '',
    new_deal_amount: '',
    commission_pct: '10.00%',
    original_commission: '500.00',
    override_amount: '',
    final_invoiced_amount: '500.00',
    extraColumns: {},
    freeformNotes: '',
    ...overrides,
  };
}

function makeBatchItem(overrides: Partial<BatchItemForImport> = {}): BatchItemForImport {
  return {
    commission_entry_id: 'entry-1',
    batch_item_id: 'item-1',
    client_name: 'Acme Corp',
    service_name: 'SEO Retainer',
    deal_label: 'SEO Retainer',
    payment_sequence: '1 of 12',
    payable_date: '2026-02-15',
    amount_claimed_on: '5000.00',
    is_renewal: 'No',
    previous_deal_amount: '',
    new_deal_amount: '',
    commission_pct: '10.00%',
    original_commission: '500.00',
    override_amount: '',
    final_invoiced_amount: '500.00',
    adjustment_note: null,
    override_payment_date: null,
    override_commission_rate: null,
    override_amount_collected: null,
    amount: 500,
    amount_collected: 5000,
    commission_rate: 0.1,
    billing_type: 'mrr',
    ...overrides,
  };
}

describe('parseCommissionReportBuffer', () => {
  it('parses 12-column header row layout', () => {
    const csv = [
      'Client,Deal,Payment,Payable date,Amount claimed on,Is renewal,Previous deal amount,New deal amount,Commission %,Original commission,Override amount,Final invoiced amount,Notes',
      'Acme Corp,SEO Retainer,1 of 12,2026-02-15,5000,No,,,10.00%,500,,500,Not paid yet',
    ].join('\n');
    const rows = parseCommissionReportBuffer(Buffer.from(csv), 'report.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0].client_name).toBe('Acme Corp');
    expect(rows[0].payment_sequence).toBe('1 of 12');
    expect(rows[0].freeformNotes).toContain('Not paid yet');
  });
});

describe('matchBossRowsToBatchItems', () => {
  it('matches by client deal payment and date', () => {
    const boss = makeBossRow();
    const item = makeBatchItem();
    const results = matchBossRowsToBatchItems([boss], [item]);
    expect(results[0].matchStatus).toBe('matched');
    expect(results[0].commission_entry_id).toBe('entry-1');
  });

  it('returns unmatched when client differs', () => {
    const boss = makeBossRow({ client_name: 'Unknown' });
    const results = matchBossRowsToBatchItems([boss], [makeBatchItem()]);
    expect(results[0].matchStatus).toBe('unmatched');
  });
});

describe('diffBossRowAgainstCurrent', () => {
  it('detects payable date and final amount changes', () => {
    const boss = makeBossRow({
      payable_date: '2026-03-01',
      final_invoiced_amount: '450.00',
      override_amount: '450.00',
    });
    const current = makeBatchItem();
    const changes = diffBossRowAgainstCurrent(boss, current);
    expect(changes.some((c) => c.action === 'update_payment_date')).toBe(true);
    expect(changes.some((c) => c.action === 'adjust_amount')).toBe(true);
  });

  it('suggests ignore for not-gone-through notes', () => {
    const boss = makeBossRow({ freeformNotes: 'Has not gone through yet — hold' });
    const changes = diffBossRowAgainstCurrent(boss, makeBatchItem());
    expect(changes.some((c) => c.action === 'ignore_entry')).toBe(true);
  });
});
