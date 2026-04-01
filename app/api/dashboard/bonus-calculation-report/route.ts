import { NextRequest } from 'next/server';
import { format } from 'date-fns';
import * as XLSX from 'xlsx-js-style';
import { createClient } from '@/lib/supabase/server';
import { apiError, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import { getQuarterFromDate, parseQuarter } from '@/lib/commission/calculator';
import {
  applyReportExcelStyles,
  escapeCsvForReport,
  formatMonthHeadingFromYyyyMm,
  type ReportExcelRowType,
} from '@/lib/commission/report-export-xlsx';
import {
  basisLabelForType,
  filenameForQuarterlyBonus,
  fetchClosedDealsBonusRowsLocal,
  fetchPayableBonusRowsLocal,
  fetchClosedDealsBonusRowsSupabase,
  fetchPayableBonusRowsSupabase,
  groupClosedDealRowsByDealId,
  groupPayableRowsByMonth,
  loadQuarterlyBonusMetaLocal,
  loadQuarterlyBonusMetaSupabase,
  type ClosedDealsBonusRow,
  type PayableBonusRow,
  type QuarterlyBonusReportType,
} from '@/lib/dashboard/quarterly-bonus-export';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

const QUARTER_RE = /^\d{4}-Q[1-4]$/;

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const bdrIdParam = searchParams.get('bdr_id');
    const quarterParam = searchParams.get('quarter');
    const typeParam = searchParams.get('type') as QuarterlyBonusReportType | null;
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

    if (!typeParam || !['payable', 'cash', 'closed_deals'].includes(typeParam)) {
      return apiError('type must be payable, cash, or closed_deals', 400);
    }

    if (formatParam !== 'csv' && formatParam !== 'xlsx') {
      return apiError('format must be csv or xlsx', 400);
    }

    const today = new Date();
    const todayStr = format(today, 'yyyy-MM-dd');
    const quarter =
      quarterParam && QUARTER_RE.test(quarterParam) ? quarterParam : getQuarterFromDate(today);

    if (!QUARTER_RE.test(quarter)) {
      return apiError('Invalid quarter (use YYYY-Q1 .. Q4)', 400);
    }

    const { start: quarterStart, end: quarterEnd } = parseQuarter(quarter);
    const quarterStartStr = format(quarterStart, 'yyyy-MM-dd');
    const quarterEndStr = format(quarterEnd, 'yyyy-MM-dd');

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();
      const meta = loadQuarterlyBonusMetaLocal(db, targetBdrId, quarter, quarterStartStr, quarterEndStr, todayStr);

      if (typeParam === 'payable' || typeParam === 'cash') {
        const payableOpts =
          typeParam === 'cash' ? { maxPayableDateInclusive: todayStr } : undefined;
        const data = fetchPayableBonusRowsLocal(
          db,
          targetBdrId,
          quarterStartStr,
          quarterEndStr,
          payableOpts
        );
        return buildPayableResponse(data.rows, meta, quarter, targetBdrId, typeParam, formatParam, data.totalBonus, data.totalAttributedRevenue);
      }
      const data = fetchClosedDealsBonusRowsLocal(db, targetBdrId, quarterStartStr, quarterEndStr);
      return buildClosedDealsResponse(
        data.rows,
        meta,
        quarter,
        targetBdrId,
        typeParam,
        formatParam,
        data.totalBasisCommission,
        data.totalBaseAmount
      );
    }

    const supabase = await createClient();
    const meta = await loadQuarterlyBonusMetaSupabase(
      supabase,
      targetBdrId,
      quarter,
      quarterStartStr,
      quarterEndStr,
      todayStr
    );

    if (typeParam === 'payable' || typeParam === 'cash') {
      const payableOpts =
        typeParam === 'cash' ? { maxPayableDateInclusive: todayStr } : undefined;
      const data = await fetchPayableBonusRowsSupabase(
        supabase,
        targetBdrId,
        quarterStartStr,
        quarterEndStr,
        payableOpts
      );
      return buildPayableResponse(data.rows, meta, quarter, targetBdrId, typeParam, formatParam, data.totalBonus, data.totalAttributedRevenue);
    }
    const data = await fetchClosedDealsBonusRowsSupabase(supabase, targetBdrId, quarterStartStr, quarterEndStr);
    return buildClosedDealsResponse(
      data.rows,
      meta,
      quarter,
      targetBdrId,
      typeParam,
      formatParam,
      data.totalBasisCommission,
      data.totalBaseAmount
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unauthorized';
    return apiError(message, 401);
  }
}

function metaLine(meta: { quarterlyTarget: number; revenueCollectedForTarget: number; achievedPercent: number; bonusEligible: boolean }) {
  return `Target $${meta.quarterlyTarget.toLocaleString('en-US')} | Cash collected (quarter) $${meta.revenueCollectedForTarget.toFixed(2)} (${meta.achievedPercent.toFixed(1)}%) | Bonus eligible: ${meta.bonusEligible ? 'Yes' : 'No'}`;
}

function buildPayableResponse(
  rows: PayableBonusRow[],
  meta: {
    quarterlyTarget: number;
    revenueCollectedForTarget: number;
    achievedPercent: number;
    bonusEligible: boolean;
  },
  quarter: string,
  bdrId: string,
  type: QuarterlyBonusReportType,
  fileFormat: string,
  totalBonus: number,
  totalAttributed: number
) {
  const headers = [
    'Client',
    'Deal',
    'Payable date',
    'Collection date',
    'Entry commission',
    'Attributed revenue',
    'Bonus @ 2.5%',
  ];
  const asOfDay = format(new Date(), 'yyyy-MM-dd');
  const preamble = [
    'Quarterly bonus — calculation report',
    basisLabelForType(type),
    ...(type === 'cash'
      ? [
          `As of ${asOfDay}: lines are limited to payable_date ≤ ${asOfDay} while still within ${quarter} (not bank cash; same attribution rules as full-quarter payable).`,
        ]
      : []),
    `Quarter: ${quarter} | BDR: ${bdrId} | Generated: ${format(new Date(), 'yyyy-MM-dd HH:mm')}`,
    metaLine(meta),
    `Total attributed revenue: $${totalAttributed.toFixed(2)} | Total quarterly bonus (2.5%): $${totalBonus.toFixed(2)}`,
  ];
  const { rowsByMonth, sortedMonths } = groupPayableRowsByMonth(rows);
  const colPad = ['', '', '', '', '', ''] as const;

  if (fileFormat === 'xlsx') {
    const worksheetData: (string | number)[][] = [];
    const rowTypes: ReportExcelRowType[] = [];
    for (const line of preamble) {
      worksheetData.push([line, '', '', '', '', '', '']);
      rowTypes.push('title');
    }
    worksheetData.push([]);
    rowTypes.push('blank');
    worksheetData.push(headers);
    rowTypes.push('header');
    for (const month of sortedMonths) {
      const monthRows = rowsByMonth[month];
      const monthBonus = monthRows.reduce((s, r) => s + parseFloat(r.bonus_at_2_5 || '0'), 0);
      const monthRev = monthRows.reduce((s, r) => s + parseFloat(r.attributed_revenue || '0'), 0);
      worksheetData.push([`${formatMonthHeadingFromYyyyMm(month)} — revenue $${monthRev.toFixed(2)} | bonus $${monthBonus.toFixed(2)}`, ...colPad]);
      rowTypes.push('month');
      for (const r of monthRows) {
        worksheetData.push([
          r.client_name,
          r.deal,
          r.payable_date,
          r.collection_date,
          r.entry_commission,
          r.attributed_revenue,
          r.bonus_at_2_5,
        ]);
        rowTypes.push('data');
      }
    }
    worksheetData.push([]);
    rowTypes.push('blank');
    worksheetData.push(['TOTAL', '', '', '', '', totalAttributed.toFixed(2), totalBonus.toFixed(2)]);
    rowTypes.push('total');
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
    applyReportExcelStyles(worksheet, rowTypes);
    worksheet['!cols'] = [{ wch: 22 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 12 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Quarterly Bonus');
    const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const filename = filenameForQuarterlyBonus(quarter, type, 'xlsx');
    return new Response(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  const csvLines: string[] = [...preamble, '', headers.join(',')];
  for (const month of sortedMonths) {
    const monthRows = rowsByMonth[month];
    const monthBonus = monthRows.reduce((s, r) => s + parseFloat(r.bonus_at_2_5 || '0'), 0);
    const monthRev = monthRows.reduce((s, r) => s + parseFloat(r.attributed_revenue || '0'), 0);
    csvLines.push(
      [escapeCsvForReport(`${formatMonthHeadingFromYyyyMm(month)} — revenue $${monthRev.toFixed(2)} | bonus $${monthBonus.toFixed(2)}`), ...colPad].join(',')
    );
    for (const r of monthRows) {
      csvLines.push(
        [
          escapeCsvForReport(r.client_name),
          escapeCsvForReport(r.deal),
          escapeCsvForReport(r.payable_date),
          escapeCsvForReport(r.collection_date),
          r.entry_commission,
          r.attributed_revenue,
          r.bonus_at_2_5,
        ].join(',')
      );
    }
    csvLines.push('');
  }
  csvLines.push(['TOTAL', '', '', '', '', totalAttributed.toFixed(2), totalBonus.toFixed(2)].join(','));
  const filename = filenameForQuarterlyBonus(quarter, type, 'csv');
  return new Response(csvLines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function buildClosedDealsResponse(
  rows: ClosedDealsBonusRow[],
  meta: {
    quarterlyTarget: number;
    revenueCollectedForTarget: number;
    achievedPercent: number;
    bonusEligible: boolean;
  },
  quarter: string,
  bdrId: string,
  type: QuarterlyBonusReportType,
  fileFormat: string,
  totalBasisCommission: number,
  totalBaseAmount: number
) {
  const headers = ['Client', 'Deal', 'Is renewal', 'Base amount', 'Rate %', 'Basis commission'];
  const preamble = [
    'Quarterly bonus — calculation report',
    basisLabelForType(type),
    `Quarter: ${quarter} | BDR: ${bdrId} | Generated: ${format(new Date(), 'yyyy-MM-dd HH:mm')}`,
    metaLine(meta),
    `Total base amount: $${totalBaseAmount.toFixed(2)} | Total basis commission (rate × base): $${totalBasisCommission.toFixed(2)}`,
  ];
  const { rowsByDeal, sortedDealIds } = groupClosedDealRowsByDealId(rows);
  const colPad = ['', '', '', '', ''] as const;

  if (fileFormat === 'xlsx') {
    const worksheetData: (string | number)[][] = [];
    const rowTypes: ReportExcelRowType[] = [];
    for (const line of preamble) {
      worksheetData.push([line, '', '', '', '', '']);
      rowTypes.push('title');
    }
    worksheetData.push([]);
    rowTypes.push('blank');
    worksheetData.push(headers);
    rowTypes.push('header');
    for (const dealId of sortedDealIds) {
      const dealRows = rowsByDeal[dealId];
      const sub = dealRows.reduce((s, r) => s + parseFloat(r.basis_commission || '0'), 0);
      const label = dealRows[0] ? `${dealRows[0].client_name} — subtotal` : dealId;
      worksheetData.push([`${label}: $${sub.toFixed(2)}`, ...colPad]);
      rowTypes.push('month');
      for (const r of dealRows) {
        worksheetData.push([r.client_name, r.deal, r.is_renewal, r.base_amount, r.rate_pct, r.basis_commission]);
        rowTypes.push('data');
      }
    }
    worksheetData.push([]);
    rowTypes.push('blank');
    worksheetData.push(['TOTAL', '', '', totalBaseAmount.toFixed(2), '', totalBasisCommission.toFixed(2)]);
    rowTypes.push('total');
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
    applyReportExcelStyles(worksheet, rowTypes);
    worksheet['!cols'] = [{ wch: 22 }, { wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 16 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Quarterly Bonus');
    const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const filename = filenameForQuarterlyBonus(quarter, type, 'xlsx');
    return new Response(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  const csvLines: string[] = [...preamble, '', headers.join(',')];
  for (const dealId of sortedDealIds) {
    const dealRows = rowsByDeal[dealId];
    const sub = dealRows.reduce((s, r) => s + parseFloat(r.basis_commission || '0'), 0);
    const label = dealRows[0] ? `${dealRows[0].client_name} — subtotal` : dealId;
    csvLines.push([escapeCsvForReport(`${label}: $${sub.toFixed(2)}`), ...colPad].join(','));
    for (const r of dealRows) {
      csvLines.push(
        [
          escapeCsvForReport(r.client_name),
          escapeCsvForReport(r.deal),
          escapeCsvForReport(r.is_renewal),
          r.base_amount,
          escapeCsvForReport(r.rate_pct),
          r.basis_commission,
        ].join(',')
      );
    }
    csvLines.push('');
  }
  csvLines.push(['TOTAL', '', '', totalBaseAmount.toFixed(2), '', totalBasisCommission.toFixed(2)].join(','));
  const filename = filenameForQuarterlyBonus(quarter, type, 'csv');
  return new Response(csvLines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
