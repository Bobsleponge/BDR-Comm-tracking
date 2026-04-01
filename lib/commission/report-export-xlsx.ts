import * as XLSX from 'xlsx-js-style';

/** Excel cell styles – professional blue palette (shared: commission batch + quarterly bonus reports) */
export const REPORT_EXCEL_STYLES = {
  header: {
    fill: { fgColor: { rgb: '2E75B6' } },
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
    alignment: { horizontal: 'center' },
  },
  monthHeading: {
    fill: { fgColor: { rgb: '4472C4' } },
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 12 },
    alignment: { horizontal: 'left' },
  },
  titleBand: {
    fill: { fgColor: { rgb: '4472C4' } },
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
    alignment: { horizontal: 'left' },
  },
  dataRow: { fill: { fgColor: { rgb: 'FFFFFF' } } },
  dataRowAlt: { fill: { fgColor: { rgb: 'DDEBF7' } } },
  totalRow: {
    fill: { fgColor: { rgb: '1F4E79' } },
    font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
  },
};

export type ReportExcelRowType = 'title' | 'header' | 'month' | 'data' | 'total' | 'blank';

/**
 * Apply alternating data rows and band colors (commission + quarterly bonus exports).
 */
export function applyReportExcelStyles(worksheet: XLSX.WorkSheet, rowTypes: ReportExcelRowType[]) {
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
  let dataRowIndex = 0;
  for (let R = range.s.r; R <= range.e.r; R++) {
    const rowType = rowTypes[R];
    if (!rowType) continue;
    let style;
    if (rowType === 'title') style = REPORT_EXCEL_STYLES.titleBand;
    else if (rowType === 'header') style = REPORT_EXCEL_STYLES.header;
    else if (rowType === 'month') style = REPORT_EXCEL_STYLES.monthHeading;
    else if (rowType === 'total') style = REPORT_EXCEL_STYLES.totalRow;
    else if (rowType === 'data') {
      style = dataRowIndex % 2 === 0 ? REPORT_EXCEL_STYLES.dataRow : REPORT_EXCEL_STYLES.dataRowAlt;
      dataRowIndex++;
    } else continue;
    for (let C = range.s.c; C <= range.e.c; C++) {
      const ref = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = worksheet[ref];
      if (cell) cell.s = style;
    }
  }
}

export function escapeCsvForReport(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function formatMonthHeadingFromYyyyMm(monthStr: string): string {
  if (!monthStr) return 'Unknown month';
  const [y, m] = monthStr.split('-');
  return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}
