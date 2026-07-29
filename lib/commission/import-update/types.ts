import type { ExportRow } from '@/lib/commission/export-rows';

/** Standard commission report column headers (12 columns). */
export const REPORT_HEADERS = [
  'Client',
  'Deal',
  'Payment',
  'Payable date',
  'Amount claimed on',
  'Is renewal',
  'Previous deal amount',
  'New deal amount',
  'Commission %',
  'Original commission',
  'Override amount',
  'Final invoiced amount',
] as const;

export type BatchActionType =
  | 'adjust_amount'
  | 'update_payment_date'
  | 'update_commission_rate'
  | 'update_amount_claimed'
  | 'ignore_entry'
  | 'remove_entry'
  | 'override_to_renewal'
  | 'add_note';

export interface ParsedImportRow extends ExportRow {
  /** 0-based row index in source file (data rows only). */
  sourceRowIndex: number;
  /** Extra columns beyond the 12 standard headers (notes, instructions, etc.). */
  extraColumns: Record<string, string>;
  /** Combined free-form text from extra columns and cell comments. */
  freeformNotes: string;
  /** Best-effort: row had highlighted/styled cells in Excel. */
  hasHighlight?: boolean;
}

export interface BatchItemForImport {
  commission_entry_id: string;
  batch_item_id: string;
  client_name: string;
  service_name: string;
  deal_label: string;
  payment_sequence: string;
  payable_date: string;
  amount_claimed_on: string;
  is_renewal: string;
  previous_deal_amount: string;
  new_deal_amount: string;
  commission_pct: string;
  original_commission: string;
  override_amount: string;
  final_invoiced_amount: string;
  adjustment_note: string | null;
  override_payment_date: string | null;
  override_commission_rate: number | null;
  override_amount_collected: number | null;
  amount: number | null;
  amount_collected: number | null;
  commission_rate: number | null;
  billing_type: string;
}

export type ChangeSource = 'column' | 'note' | 'ai' | 'manual';

export interface ProposedChange {
  action: BatchActionType;
  field: string;
  currentValue: string | number | null;
  proposedValue: string | number | null;
  description: string;
  source: ChangeSource;
  confidence?: number;
}

export type MatchStatus = 'matched' | 'ambiguous' | 'unmatched';

export interface ImportProposalLine {
  rowIndex: number;
  commission_entry_id?: string;
  batch_item_id?: string;
  matchStatus: MatchStatus;
  bossRow: ParsedImportRow;
  current?: BatchItemForImport;
  changes: ProposedChange[];
  needsClarification: boolean;
  clarificationQuestion?: string;
  accepted: boolean;
}

export interface ImportProposal {
  batchId: string;
  batchStatus: string;
  aiEnabled: boolean;
  summary: {
    totalBossRows: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
    withChanges: number;
    needsClarification: number;
  };
  lines: ImportProposalLine[];
  /** Batch items with no corresponding boss row. */
  unaddressedEntryIds: string[];
}

/** Payload for applying approved changes. */
export interface ApplyChangePayload {
  commission_entry_id: string;
  action: BatchActionType;
  override_amount?: number | null;
  override_payment_date?: string | null;
  override_commission_rate?: number | null;
  override_amount_collected?: number | null;
  adjustment_note?: string | null;
  previous_deal_amount?: number;
}

export interface AiInterpretResult {
  action?: BatchActionType;
  proposedValue?: string | number | null;
  description?: string;
  confidence?: number;
  needs_clarification?: boolean;
  question?: string;
}
