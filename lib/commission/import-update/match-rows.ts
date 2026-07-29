import type { BatchItemForImport, MatchStatus, ParsedImportRow } from './types';

export interface RowMatchResult {
  bossRow: ParsedImportRow;
  matchStatus: MatchStatus;
  commission_entry_id?: string;
  batch_item_id?: string;
  current?: BatchItemForImport;
  candidateIds?: string[];
}

function norm(s: string | null | undefined): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normDate(s: string | null | undefined): string {
  const t = String(s ?? '').trim();
  return t.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : t;
}

function parseMoney(s: string | null | undefined): number | null {
  if (s == null || s === '' || s === 'TBD') return null;
  const n = Number.parseFloat(String(s).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function amountsClose(a: number | null, b: number | null, tolerance = 0.02): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tolerance;
}

function scoreMatch(boss: ParsedImportRow, item: BatchItemForImport): number {
  let score = 0;
  if (norm(boss.client_name) === norm(item.client_name)) score += 40;
  else return 0;

  const bossDeal = norm(boss.deal);
  const itemDeal = norm(item.deal_label);
  if (bossDeal && itemDeal && (bossDeal === itemDeal || itemDeal.includes(bossDeal) || bossDeal.includes(itemDeal))) {
    score += 25;
  } else if (!bossDeal || !itemDeal) {
    score += 5;
  } else {
    return 0;
  }

  const bossPaySeq = norm(boss.payment_sequence);
  const itemPaySeq = norm(item.payment_sequence);
  if (bossPaySeq && itemPaySeq && bossPaySeq === itemPaySeq) score += 20;
  else if (!bossPaySeq || !itemPaySeq) score += 3;

  const bossDate = normDate(boss.payable_date);
  const itemDate = normDate(item.payable_date);
  if (bossDate && itemDate && bossDate === itemDate) score += 10;
  else if (bossDate && itemDate && bossDate.slice(0, 7) === itemDate.slice(0, 7)) score += 5;

  const bossFinal = parseMoney(boss.final_invoiced_amount) ?? parseMoney(boss.original_commission);
  const itemFinal = parseMoney(item.final_invoiced_amount) ?? parseMoney(item.original_commission);
  if (amountsClose(bossFinal, itemFinal)) score += 5;

  return score;
}

const MIN_MATCH_SCORE = 65;

/**
 * Match boss-imported rows to batch items by identity fields.
 */
export function matchBossRowsToBatchItems(
  bossRows: ParsedImportRow[],
  batchItems: BatchItemForImport[]
): RowMatchResult[] {
  const usedEntryIds = new Set<string>();
  const results: RowMatchResult[] = [];

  for (const bossRow of bossRows) {
    const scored = batchItems
      .map((item) => ({ item, score: scoreMatch(bossRow, item) }))
      .filter(({ score }) => score >= MIN_MATCH_SCORE)
      .sort((a, b) => b.score - a.score);

    const available = scored.filter(({ item }) => !usedEntryIds.has(item.commission_entry_id));

    if (available.length === 0) {
      results.push({ bossRow, matchStatus: 'unmatched' });
      continue;
    }

    const top = available[0];
    const tied = available.filter(({ score }) => score === top.score);

    if (tied.length > 1) {
      results.push({
        bossRow,
        matchStatus: 'ambiguous',
        candidateIds: tied.map(({ item }) => item.commission_entry_id),
      });
      continue;
    }

    usedEntryIds.add(top.item.commission_entry_id);
    results.push({
      bossRow,
      matchStatus: 'matched',
      commission_entry_id: top.item.commission_entry_id,
      batch_item_id: top.item.batch_item_id,
      current: top.item,
    });
  }

  return results;
}

/** Batch items not matched to any boss row. */
export function findUnaddressedEntryIds(
  batchItems: BatchItemForImport[],
  matchResults: RowMatchResult[]
): string[] {
  const matched = new Set(
    matchResults.filter((r) => r.matchStatus === 'matched' && r.commission_entry_id).map((r) => r.commission_entry_id!)
  );
  return batchItems.filter((i) => !matched.has(i.commission_entry_id)).map((i) => i.commission_entry_id);
}
