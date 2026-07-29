import { chatJson, isAiEnabled } from '@/lib/ai/client';
import type { AiInterpretResult, BatchActionType, BatchItemForImport, ParsedImportRow, ProposedChange } from './types';

const VALID_ACTIONS: BatchActionType[] = [
  'adjust_amount',
  'update_payment_date',
  'update_commission_rate',
  'update_amount_claimed',
  'ignore_entry',
  'remove_entry',
  'override_to_renewal',
  'add_note',
];

function aiResultToChange(result: AiInterpretResult): ProposedChange | null {
  if (result.needs_clarification) return null;
  if (!result.action || !VALID_ACTIONS.includes(result.action)) return null;

  return {
    action: result.action,
    field: result.action,
    currentValue: null,
    proposedValue: result.proposedValue ?? null,
    description: result.description ?? `AI suggested ${result.action}`,
    source: 'ai',
    confidence: result.confidence ?? 0.7,
  };
}

/**
 * Use AI to interpret free-form boss notes into structured commission changes.
 */
export async function interpretBossNoteWithAi(
  boss: ParsedImportRow,
  current: BatchItemForImport | undefined,
  existingChanges: ProposedChange[],
  clarificationAnswer?: string
): Promise<{ change?: ProposedChange; needsClarification: boolean; question?: string }> {
  if (!isAiEnabled()) {
    return { needsClarification: true, question: 'AI is not configured. Review the boss note manually.' };
  }

  const note = clarificationAnswer
    ? `${boss.freeformNotes}\n\nUser clarification: ${clarificationAnswer}`
    : boss.freeformNotes;

  if (!note?.trim()) {
    return { needsClarification: false };
  }

  const system = `You interpret boss feedback on BDR commission report line items.
Return JSON only with this shape:
{
  "action": "adjust_amount" | "update_payment_date" | "update_commission_rate" | "update_amount_claimed" | "ignore_entry" | "remove_entry" | "override_to_renewal" | "add_note" | null,
  "proposedValue": string | number | null,
  "description": string,
  "confidence": number between 0 and 1,
  "needs_clarification": boolean,
  "question": string | null
}

Rules:
- "hasn't gone through", "not paid", "remove from this report" → ignore_entry or update_payment_date to a future date if a date is given.
- Amount changes → adjust_amount with numeric dollar value.
- Commission rate changes → update_commission_rate as decimal (0.025 = 2.5%).
- Amount claimed / net sales → update_amount_claimed.
- If ambiguous, set needs_clarification true and ask a specific question.
- Do not duplicate changes already detected: ${JSON.stringify(existingChanges.map((c) => c.action))}.`;

  const user = JSON.stringify({
    bossRow: {
      client: boss.client_name,
      deal: boss.deal,
      payment: boss.payment_sequence,
      payable_date: boss.payable_date,
      amount_claimed_on: boss.amount_claimed_on,
      commission_pct: boss.commission_pct,
      override_amount: boss.override_amount,
      final_invoiced_amount: boss.final_invoiced_amount,
    },
    current: current
      ? {
          payable_date: current.payable_date,
          amount_claimed_on: current.amount_claimed_on,
          commission_pct: current.commission_pct,
          override_amount: current.override_amount,
          final_invoiced_amount: current.final_invoiced_amount,
          adjustment_note: current.adjustment_note,
        }
      : null,
    bossNote: note,
  });

  const result = await chatJson<AiInterpretResult>({ system, user });
  if (!result) {
    return {
      needsClarification: true,
      question: 'Could not interpret the boss note automatically. Please decide manually.',
    };
  }

  if (result.needs_clarification) {
    return {
      needsClarification: true,
      question: result.question ?? 'What change should be applied for this line?',
    };
  }

  const change = aiResultToChange(result);
  return { change: change ?? undefined, needsClarification: false };
}

export { isAiEnabled };
