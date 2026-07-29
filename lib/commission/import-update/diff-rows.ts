import type { BatchItemForImport, ParsedImportRow, ProposedChange } from './types';

function normDate(s: string | null | undefined): string {
  const t = String(s ?? '').trim();
  return t.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : t;
}

function parseMoney(s: string | null | undefined): number | null {
  if (s == null || s === '' || s === 'TBD') return null;
  const n = Number.parseFloat(String(s).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parsePct(s: string | null | undefined): number | null {
  if (s == null || s === '') return null;
  const cleaned = String(s).replace('%', '').trim();
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function amountsDiffer(a: number | null, b: number | null, tolerance = 0.02): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > tolerance;
}

function strDiff(a: string, b: string): boolean {
  return String(a ?? '').trim() !== String(b ?? '').trim();
}

const NOT_GONE_THROUGH = /\b(not\s+(gone\s+through|paid|collected|received)|hasn'?t\s+(gone\s+through|paid|collected|received)|didn'?t\s+(go\s+through|pay|collect)|remove|exclude|ignore|hold|defer|delay|push\s+back|future\s+report|wait)\b/i;

/**
 * Compare boss structured columns against current batch export values.
 */
export function diffBossRowAgainstCurrent(
  boss: ParsedImportRow,
  current: BatchItemForImport
): ProposedChange[] {
  const changes: ProposedChange[] = [];

  const bossPayable = normDate(boss.payable_date);
  const curPayable = normDate(current.payable_date);
  if (bossPayable && curPayable && bossPayable !== curPayable) {
    changes.push({
      action: 'update_payment_date',
      field: 'payable_date',
      currentValue: curPayable,
      proposedValue: bossPayable,
      description: `Payable date ${curPayable} → ${bossPayable}`,
      source: 'column',
      confidence: 0.95,
    });
  }

  const bossClaimed = parseMoney(boss.amount_claimed_on);
  const curClaimed = parseMoney(current.amount_claimed_on);
  if (amountsDiffer(bossClaimed, curClaimed)) {
    changes.push({
      action: 'update_amount_claimed',
      field: 'amount_claimed_on',
      currentValue: curClaimed,
      proposedValue: bossClaimed,
      description: `Amount claimed on ${curClaimed ?? '—'} → ${bossClaimed ?? '—'}`,
      source: 'column',
      confidence: 0.9,
    });
  }

  const bossRate = parsePct(boss.commission_pct);
  const curRate = parsePct(current.commission_pct);
  if (bossRate != null && curRate != null && Math.abs(bossRate - curRate) > 1e-6) {
    changes.push({
      action: 'update_commission_rate',
      field: 'commission_pct',
      currentValue: curRate,
      proposedValue: bossRate,
      description: `Commission rate ${(curRate * 100).toFixed(2)}% → ${(bossRate * 100).toFixed(2)}%`,
      source: 'column',
      confidence: 0.9,
    });
  }

  const bossOverride = parseMoney(boss.override_amount);
  const curOverride = parseMoney(current.override_amount);
  if (amountsDiffer(bossOverride, curOverride)) {
    changes.push({
      action: 'adjust_amount',
      field: 'override_amount',
      currentValue: curOverride,
      proposedValue: bossOverride,
      description: `Override amount ${curOverride ?? '—'} → ${bossOverride ?? '—'}`,
      source: 'column',
      confidence: 0.95,
    });
  }

  const bossFinal = parseMoney(boss.final_invoiced_amount);
  const curFinal = parseMoney(current.final_invoiced_amount);
  const bossOrig = parseMoney(boss.original_commission);
  const curOrig = parseMoney(current.original_commission);

  // Final amount changed without explicit override — treat as override amount adjustment
  if (
    amountsDiffer(bossFinal, curFinal) &&
    !changes.some((c) => c.action === 'adjust_amount') &&
    bossFinal != null
  ) {
    changes.push({
      action: 'adjust_amount',
      field: 'final_invoiced_amount',
      currentValue: curFinal,
      proposedValue: bossFinal,
      description: `Final invoiced amount ${curFinal ?? '—'} → ${bossFinal}`,
      source: 'column',
      confidence: 0.85,
    });
  }

  if (amountsDiffer(bossOrig, curOrig) && bossOrig != null && bossOrig === 0) {
    // Boss zeroed out commission — likely ignore or remove
    changes.push({
      action: 'ignore_entry',
      field: 'original_commission',
      currentValue: curOrig,
      proposedValue: 0,
      description: 'Boss set commission to zero — may need to ignore or defer this entry',
      source: 'column',
      confidence: 0.6,
    });
  }

  // Deterministic interpretation of common free-form phrases in extra columns
  const notes = boss.freeformNotes;
  if (notes && NOT_GONE_THROUGH.test(notes)) {
    const hasPaymentChange = changes.some((c) => c.action === 'update_payment_date');
    if (!hasPaymentChange) {
      changes.push({
        action: 'ignore_entry',
        field: 'freeformNotes',
        currentValue: null,
        proposedValue: null,
        description: `Boss note suggests transaction has not gone through: "${notes}"`,
        source: 'note',
        confidence: 0.55,
      });
    }
  } else if (notes && !changes.length) {
    changes.push({
      action: 'add_note',
      field: 'adjustment_note',
      currentValue: current.adjustment_note,
      proposedValue: notes,
      description: `Boss note: ${notes}`,
      source: 'note',
      confidence: 0.5,
    });
  } else if (notes && changes.length) {
    changes.push({
      action: 'add_note',
      field: 'adjustment_note',
      currentValue: current.adjustment_note,
      proposedValue: notes,
      description: `Boss note: ${notes}`,
      source: 'note',
      confidence: 0.7,
    });
  }

  return changes;
}

/** Merge AI-suggested change, avoiding duplicate actions on same field. */
export function mergeAiChange(changes: ProposedChange[], aiChange: ProposedChange): ProposedChange[] {
  const existing = changes.find((c) => c.action === aiChange.action && c.field === aiChange.field);
  if (existing) return changes;
  return [...changes, aiChange];
}
