import * as XLSX from 'xlsx';
import type { ParsedImportRow } from './types';
import { REPORT_HEADERS } from './types';

function normalizePayableDate(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = XLSX.SSF.parse_date_code(raw);
    if (d) {
      const mm = String(d.m).padStart(2, '0');
      const dd = String(d.d).padStart(2, '0');
      return `${d.y}-${mm}-${dd}`;
    }
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const y = raw.getFullYear();
    const mm = String(raw.getMonth() + 1).padStart(2, '0');
    const dd = String(raw.getDate()).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }
  const s = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function cellToString(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return normalizePayableDate(raw);
  }
  return String(raw).trim();
}

function isMonthSubheading(firstCell: string): boolean {
  return firstCell.includes('—') && firstCell.includes('$');
}

function isHeaderRow(row: unknown[]): boolean {
  const first = String(row[0] ?? '').trim().toLowerCase();
  return first === 'client';
}

function normalizeHeaderName(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ');
}

const HEADER_ALIASES: Record<string, keyof ParsedImportRow> = {
  client: 'client_name',
  deal: 'deal',
  payment: 'payment_sequence',
  'payable date': 'payable_date',
  'amount claimed on': 'amount_claimed_on',
  'is renewal': 'is_renewal',
  'previous deal amount': 'previous_deal_amount',
  'new deal amount': 'new_deal_amount',
  'commission %': 'commission_pct',
  'original commission': 'original_commission',
  'override amount': 'override_amount',
  'final invoiced amount': 'final_invoiced_amount',
};

function detectColumnMap(headerRow: unknown[]): {
  columnMap: Partial<Record<keyof ParsedImportRow, number>>;
  extraColumnIndices: Array<{ index: number; name: string }>;
} {
  const columnMap: Partial<Record<keyof ParsedImportRow, number>> = {};
  const extraColumnIndices: Array<{ index: number; name: string }> = [];
  const standardNames = new Set(REPORT_HEADERS.map((h) => normalizeHeaderName(h)));

  for (let i = 0; i < headerRow.length; i++) {
    const header = normalizeHeaderName(String(headerRow[i] ?? ''));
    if (!header) continue;
    const field = HEADER_ALIASES[header];
    if (field) {
      columnMap[field] = i;
    } else if (!standardNames.has(header)) {
      extraColumnIndices.push({ index: i, name: String(headerRow[i] ?? '').trim() || `Column ${i + 1}` });
    }
  }

  // Fallback: positional mapping for files without a header row (legacy 11-col without Payment)
  if (Object.keys(columnMap).length < 4) {
    return {
      columnMap: {
        client_name: 0,
        deal: 1,
        payment_sequence: 2,
        payable_date: 3,
        amount_claimed_on: 4,
        is_renewal: 5,
        previous_deal_amount: 6,
        new_deal_amount: 7,
        commission_pct: 8,
        original_commission: 9,
        override_amount: 10,
        final_invoiced_amount: 11,
      },
      extraColumnIndices: headerRow.slice(12).map((h, idx) => ({
        index: idx + 12,
        name: String(h ?? '').trim() || `Column ${idx + 13}`,
      })),
    };
  }

  return { columnMap, extraColumnIndices };
}

function getCell(
  row: unknown[],
  columnMap: Partial<Record<keyof ParsedImportRow, number>>,
  field: keyof ParsedImportRow
): unknown {
  const idx = columnMap[field];
  if (idx == null) return '';
  return row[idx];
}

function parseDataRows(
  data: unknown[][],
  headerRowIndex: number | null,
  columnMap: Partial<Record<keyof ParsedImportRow, number>>,
  extraColumnIndices: Array<{ index: number; name: string }>
): ParsedImportRow[] {
  const rows: ParsedImportRow[] = [];
  const startIndex = headerRowIndex != null ? headerRowIndex + 1 : 0;

  for (let i = startIndex; i < data.length; i++) {
    const row = data[i];
    if (!Array.isArray(row) || row.length < 2) continue;

    const firstCell = String(row[0] ?? '').trim();
    if (!firstCell) continue;
    if (firstCell === 'TOTAL') break;
    if (isMonthSubheading(firstCell)) continue;
    if (isHeaderRow(row)) continue;

    const client_name = cellToString(getCell(row, columnMap, 'client_name'));
    const payable_date = normalizePayableDate(getCell(row, columnMap, 'payable_date'));
    if (!client_name) continue;

    const extraColumns: Record<string, string> = {};
    const noteParts: string[] = [];
    for (const { index, name } of extraColumnIndices) {
      const val = cellToString(row[index]);
      if (val) {
        extraColumns[name] = val;
        noteParts.push(`${name}: ${val}`);
      }
    }

    rows.push({
      sourceRowIndex: i,
      client_name,
      deal: cellToString(getCell(row, columnMap, 'deal')),
      payment_sequence: cellToString(getCell(row, columnMap, 'payment_sequence')),
      payable_date,
      amount_claimed_on: cellToString(getCell(row, columnMap, 'amount_claimed_on')),
      is_renewal: cellToString(getCell(row, columnMap, 'is_renewal')) === 'Yes' ? 'Yes' : 'No',
      previous_deal_amount: cellToString(getCell(row, columnMap, 'previous_deal_amount')),
      new_deal_amount: cellToString(getCell(row, columnMap, 'new_deal_amount')),
      commission_pct: cellToString(getCell(row, columnMap, 'commission_pct')),
      original_commission: cellToString(getCell(row, columnMap, 'original_commission')),
      override_amount: cellToString(getCell(row, columnMap, 'override_amount')),
      final_invoiced_amount: cellToString(getCell(row, columnMap, 'final_invoiced_amount')),
      extraColumns,
      freeformNotes: noteParts.join('; '),
    });
  }

  return rows;
}

/**
 * Parse an uploaded commission report (xlsx or csv buffer) into structured rows.
 */
export function parseCommissionReportBuffer(buffer: Buffer, filename: string): ParsedImportRow[] {
  const isCsv = filename.toLowerCase().endsWith('.csv');
  const workbook = isCsv
    ? XLSX.read(buffer.toString('utf8'), { type: 'string', raw: false })
    : XLSX.read(buffer, { type: 'buffer', cellDates: true });

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];

  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (data.length === 0) return [];

  let headerRowIndex: number | null = null;
  for (let i = 0; i < Math.min(data.length, 20); i++) {
    const row = data[i];
    if (Array.isArray(row) && isHeaderRow(row)) {
      headerRowIndex = i;
      break;
    }
  }

  const headerRow = headerRowIndex != null ? (data[headerRowIndex] as unknown[]) : [];
  const { columnMap, extraColumnIndices } =
    headerRowIndex != null
      ? detectColumnMap(headerRow)
      : {
          columnMap: {
            client_name: 0,
            deal: 1,
            payment_sequence: 2,
            payable_date: 3,
            amount_claimed_on: 4,
            is_renewal: 5,
            previous_deal_amount: 6,
            new_deal_amount: 7,
            commission_pct: 8,
            original_commission: 9,
            override_amount: 10,
            final_invoiced_amount: 11,
          } as Partial<Record<keyof ParsedImportRow, number>>,
          extraColumnIndices: [] as Array<{ index: number; name: string }>,
        };

  return parseDataRows(data as unknown[][], headerRowIndex, columnMap, extraColumnIndices);
}
