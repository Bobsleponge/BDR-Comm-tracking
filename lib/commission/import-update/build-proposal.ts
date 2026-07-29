import type { ParsedImportRow } from './types';
import { interpretBossNoteWithAi, isAiEnabled } from './ai-interpret';
import { diffBossRowAgainstCurrent, mergeAiChange } from './diff-rows';
import { findUnaddressedEntryIds, matchBossRowsToBatchItems } from './match-rows';
import type { BatchItemForImport, ImportProposal, ImportProposalLine } from './types';

export interface BuildProposalOptions {
  batchId: string;
  batchStatus: string;
  bossRows: ParsedImportRow[];
  batchItems: BatchItemForImport[];
}

/**
 * Orchestrate match → diff → optional AI interpretation into an import proposal.
 */
export async function buildImportProposal(options: BuildProposalOptions): Promise<ImportProposal> {
  const { batchId, batchStatus, bossRows, batchItems } = options;
  const matchResults = matchBossRowsToBatchItems(bossRows, batchItems);
  const aiEnabled = isAiEnabled();
  const lines: ImportProposalLine[] = [];

  for (const match of matchResults) {
    let changes = match.current ? diffBossRowAgainstCurrent(match.bossRow, match.current) : [];
    let needsClarification = match.matchStatus !== 'matched';
    let clarificationQuestion: string | undefined;

    if (match.matchStatus === 'ambiguous') {
      clarificationQuestion = `Multiple batch entries match this row (${match.candidateIds?.length ?? 0} candidates). Which entry should be updated?`;
    } else if (match.matchStatus === 'unmatched') {
      clarificationQuestion = 'Could not match this row to any entry in the batch. Is this a new line or a renamed client/deal?';
    }

    const hasLowConfidenceNoteChange =
      match.bossRow.freeformNotes &&
      (changes.some((c) => c.source === 'note' && (c.confidence ?? 1) < 0.7) ||
        (changes.length === 1 && changes[0]?.action === 'add_note'));

    const needsAi =
      match.matchStatus === 'matched' &&
      match.bossRow.freeformNotes &&
      (hasLowConfidenceNoteChange || changes.some((c) => c.action === 'ignore_entry' && (c.confidence ?? 1) < 0.7));

    if (needsAi && match.current) {
      const ai = await interpretBossNoteWithAi(match.bossRow, match.current, changes);
      if (ai.needsClarification) {
        needsClarification = true;
        clarificationQuestion = ai.question;
      } else if (ai.change) {
        changes = mergeAiChange(changes, ai.change);
      }
    } else if (
      match.matchStatus === 'matched' &&
      match.bossRow.freeformNotes &&
      !aiEnabled &&
      changes.some((c) => c.source === 'note' && (c.confidence ?? 1) < 0.7)
    ) {
      needsClarification = true;
      clarificationQuestion =
        'Boss left a note that needs manual review (AI not configured). Set OPENAI_API_KEY to auto-interpret notes.';
    }

    const hasActionableChanges = changes.some((c) => c.action !== 'add_note' || c.proposedValue);

    lines.push({
      rowIndex: match.bossRow.sourceRowIndex,
      commission_entry_id: match.commission_entry_id,
      batch_item_id: match.batch_item_id,
      matchStatus: match.matchStatus,
      bossRow: match.bossRow,
      current: match.current,
      changes,
      needsClarification: needsClarification || (hasActionableChanges && changes.some((c) => (c.confidence ?? 1) < 0.6)),
      clarificationQuestion,
      accepted: match.matchStatus === 'matched' && !needsClarification && hasActionableChanges,
    });
  }

  const unaddressedEntryIds = findUnaddressedEntryIds(batchItems, matchResults);

  return {
    batchId,
    batchStatus,
    aiEnabled,
    summary: {
      totalBossRows: bossRows.length,
      matched: lines.filter((l) => l.matchStatus === 'matched').length,
      ambiguous: lines.filter((l) => l.matchStatus === 'ambiguous').length,
      unmatched: lines.filter((l) => l.matchStatus === 'unmatched').length,
      withChanges: lines.filter((l) => l.changes.length > 0).length,
      needsClarification: lines.filter((l) => l.needsClarification).length,
    },
    lines,
    unaddressedEntryIds,
  };
}

/**
 * Re-interpret a single line after user provides clarification.
 */
export async function reinterpretLineWithClarification(
  line: ImportProposalLine,
  clarificationAnswer: string
): Promise<ImportProposalLine> {
  if (!line.current) return line;

  let changes = diffBossRowAgainstCurrent(line.bossRow, line.current);
  const ai = await interpretBossNoteWithAi(line.bossRow, line.current, changes, clarificationAnswer);

  if (ai.needsClarification) {
    return {
      ...line,
      needsClarification: true,
      clarificationQuestion: ai.question,
      changes,
      accepted: false,
    };
  }

  if (ai.change) {
    changes = mergeAiChange(changes, ai.change);
  }

  return {
    ...line,
    needsClarification: false,
    clarificationQuestion: undefined,
    changes,
    accepted: changes.length > 0,
  };
}
