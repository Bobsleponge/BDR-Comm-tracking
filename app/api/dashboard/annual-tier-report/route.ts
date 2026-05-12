import { NextRequest } from 'next/server';
import { format } from 'date-fns';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase/server';
import { apiError, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import {
  applyReportExcelStyles,
  escapeCsvForReport,
  formatMonthHeadingFromYyyyMm,
  type ReportExcelRowType,
} from '@/lib/commission/report-export-xlsx';
import {
  annualTierBasisLabel,
  filenameForAnnualTierReport,
  groupAnnualTierRowsByMonth,
  loadAnnualTierProgressLocal,
  loadAnnualTierProgressSupabase,
  type AnnualTierDetailRow,
} from '@/lib/dashboard/annual-tier-export';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function withNoCache(headers: Record<string, string>) {
  return {
    ...headers,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  };
}

function applyNumericFormats(worksheet: XLSX.WorkSheet, rowTypes: ReportExcelRowType[]) {
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
  const currencyColumns = [4, 5, 6, 7, 8, 9, 10, 11];
  for (let R = range.s.r; R <= range.e.r; R++) {
    const rowType = rowTypes[R];
    if (rowType !== 'data' && rowType !== 'total') continue;
    for (const col of currencyColumns) {
      const ref = XLSX.utils.encode_cell({ r: R, c: col });
      const cell = worksheet[ref];
      if (!cell || typeof cell.v !== 'number') continue;
      cell.z = '$#,##0.00';
    }
  }
}

function buildAnnualTierResponse(
  rows: AnnualTierDetailRow[],
  summary: ReturnType<typeof loadAnnualTierProgressLocal>['summary'],
  bdrId: string,
  fileFormat: string
) {
  const headers = [
    'Client',
    'Deal',
    'Collection date',
    'Billing type',
    'Amount collected',
    'Cumulative before',
    'Cumulative after',
    'Tier 1 revenue',
    'Tier 2 revenue',
    'Tier 1 commission',
    'Tier 2 commission',
    'Tier commission total',
  ];
  const preamble = [
    'Annual tier commission — calculation report',
    annualTierBasisLabel(),
    `Year: ${summary.year} | BDR: ${bdrId} | Generated: ${format(new Date(), 'yyyy-MM-dd HH:mm')}`,
    `Threshold: $${summary.threshold.toLocaleString('en-US')} | Tier 1: ${(summary.tier1Rate * 100).toFixed(1)}% | Tier 2: ${(summary.tier2Rate * 100).toFixed(1)}%`,
    `YTD collected: $${summary.revenueCollected.toFixed(2)} | Tier 1 revenue: $${summary.revenueInTier1.toFixed(2)} | Tier 2 revenue: $${summary.revenueInTier2.toFixed(2)}`,
    `Tier 1 commission: $${summary.tier1Commission.toFixed(2)} | Tier 2 commission: $${summary.tier2Commission.toFixed(2)} | Total modeled tier commission: $${summary.totalTierCommission.toFixed(2)}`,
    'Quarterly payable-date bonus is separate from this annual tier commission model.',
  ];
  const { rowsByMonth, sortedMonths } = groupAnnualTierRowsByMonth(rows);
  const colPad = ['', '', '', '', '', '', '', '', '', '', ''] as const;

  if (fileFormat === 'xlsx') {
    const worksheetData: (string | number)[][] = [];
    const rowTypes: ReportExcelRowType[] = [];
    for (const line of preamble) {
      worksheetData.push([line, ...colPad]);
      rowTypes.push('title');
    }
    worksheetData.push([]);
    rowTypes.push('blank');
    worksheetData.push(headers);
    rowTypes.push('header');
    for (const month of sortedMonths) {
      const monthRows = rowsByMonth[month];
      const monthCollected = monthRows.reduce((sum, row) => sum + (Number.parseFloat(row.amount_collected || '0') || 0), 0);
      const monthCommission = monthRows.reduce(
        (sum, row) => sum + (Number.parseFloat(row.tier_commission_total || '0') || 0),
        0
      );
      worksheetData.push([
        `${formatMonthHeadingFromYyyyMm(month)} — collected $${monthCollected.toFixed(2)} | tier commission $${monthCommission.toFixed(2)}`,
        ...colPad,
      ]);
      rowTypes.push('month');
      for (const row of monthRows) {
        worksheetData.push([
          row.client_name,
          row.deal,
          row.collection_date,
          row.billing_type,
          Number.parseFloat(row.amount_collected || '0') || 0,
          Number.parseFloat(row.cumulative_before || '0') || 0,
          Number.parseFloat(row.cumulative_after || '0') || 0,
          Number.parseFloat(row.tier_1_revenue || '0') || 0,
          Number.parseFloat(row.tier_2_revenue || '0') || 0,
          Number.parseFloat(row.tier_1_commission || '0') || 0,
          Number.parseFloat(row.tier_2_commission || '0') || 0,
          Number.parseFloat(row.tier_commission_total || '0') || 0,
        ]);
        rowTypes.push('data');
      }
    }
    worksheetData.push([]);
    rowTypes.push('blank');
    worksheetData.push([
      'TOTAL',
      '',
      '',
      '',
      summary.revenueCollected,
      '',
      summary.revenueCollected,
      summary.revenueInTier1,
      summary.revenueInTier2,
      summary.tier1Commission,
      summary.tier2Commission,
      summary.totalTierCommission,
    ]);
    rowTypes.push('total');
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
    applyReportExcelStyles(worksheet, rowTypes);
    applyNumericFormats(worksheet, rowTypes);
    worksheet['!cols'] = [
      { wch: 22 },
      { wch: 20 },
      { wch: 14 },
      { wch: 12 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 16 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Annual Tier');
    const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    return new Response(buf, {
      headers: withNoCache({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filenameForAnnualTierReport(summary.year, 'xlsx')}"`,
      }),
    });
  }

  const csvLines: string[] = [...preamble, '', headers.join(',')];
  for (const month of sortedMonths) {
    const monthRows = rowsByMonth[month];
    const monthCollected = monthRows.reduce((sum, row) => sum + (Number.parseFloat(row.amount_collected || '0') || 0), 0);
    const monthCommission = monthRows.reduce(
      (sum, row) => sum + (Number.parseFloat(row.tier_commission_total || '0') || 0),
      0
    );
    csvLines.push(
      [escapeCsvForReport(`${formatMonthHeadingFromYyyyMm(month)} — collected $${monthCollected.toFixed(2)} | tier commission $${monthCommission.toFixed(2)}`), ...colPad].join(',')
    );
    for (const row of monthRows) {
      csvLines.push(
        [
          escapeCsvForReport(row.client_name),
          escapeCsvForReport(row.deal),
          escapeCsvForReport(row.collection_date),
          escapeCsvForReport(row.billing_type),
          row.amount_collected,
          row.cumulative_before,
          row.cumulative_after,
          row.tier_1_revenue,
          row.tier_2_revenue,
          row.tier_1_commission,
          row.tier_2_commission,
          row.tier_commission_total,
        ].join(',')
      );
    }
  }
  csvLines.push('');
  csvLines.push(
    [
      'TOTAL',
      '',
      '',
      '',
      summary.revenueCollected.toFixed(2),
      '',
      summary.revenueCollected.toFixed(2),
      summary.revenueInTier1.toFixed(2),
      summary.revenueInTier2.toFixed(2),
      summary.tier1Commission.toFixed(2),
      summary.tier2Commission.toFixed(2),
      summary.totalTierCommission.toFixed(2),
    ].join(',')
  );
  return new Response(csvLines.join('\n'), {
    headers: withNoCache({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filenameForAnnualTierReport(summary.year, 'csv')}"`,
    }),
  });
}

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrIdParam = searchParams.get('bdr_id');
    const yearParam = searchParams.get('year');
    const formatParam = (searchParams.get('format') || 'csv').toLowerCase();

    const { isAdmin, getBdrIdFromUser } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    let targetBdrId = bdrIdParam;
    if (!isUserAdmin) {
      const userBdrId = await getBdrIdFromUser();
      if (!userBdrId) {
        return apiError('BDR profile not found', 404);
      }
      targetBdrId = userBdrId;
    }

    if (!targetBdrId) {
      return apiError('BDR ID is required', 400);
    }

    if (!(await canAccessBdr(targetBdrId))) {
      return apiError('Forbidden', 403);
    }

    if (formatParam !== 'csv' && formatParam !== 'xlsx') {
      return apiError('format must be csv or xlsx', 400);
    }

    const today = new Date();
    const todayStr = format(today, 'yyyy-MM-dd');
    const year = yearParam ? Number.parseInt(yearParam, 10) : today.getFullYear();
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      return apiError('Invalid year', 400);
    }

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const progress = loadAnnualTierProgressLocal(db, targetBdrId, year, todayStr);
      return buildAnnualTierResponse(progress.rows, progress.summary, targetBdrId, formatParam);
    }

    const supabase = await createClient();
    const progress = await loadAnnualTierProgressSupabase(supabase, targetBdrId, year, todayStr);
    return buildAnnualTierResponse(progress.rows, progress.summary, targetBdrId, formatParam);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unauthorized';
    return apiError(message, 401);
  }
}
