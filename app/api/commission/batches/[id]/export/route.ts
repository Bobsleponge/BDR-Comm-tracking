import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, requireAuth, canAccessBdr } from '@/lib/utils/api-helpers';
import * as XLSX from 'xlsx-js-style';
import {
  applyReportExcelStyles,
  escapeCsvForReport,
  formatMonthHeadingFromYyyyMm,
  type ReportExcelRowType,
} from '@/lib/commission/report-export-xlsx';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

interface ExportRow {
  client_name: string;
  deal: string;
  payable_date: string;
  amount_claimed_on: string;
  is_renewal: string;
  previous_deal_amount: string;
  new_deal_amount: string;
  commission_pct: string;
  original_commission: string;
  override_amount: string;
  final_invoiced_amount: string;
}

function toDateCell(value?: string): Date | '' {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d;
}

function toNum(value?: string): number | null {
  if (value == null || value === '') return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function applyBatchReportNumFmt(worksheet: XLSX.WorkSheet) {
  const ref = worksheet['!ref'];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  const currencyCols = new Set([3, 5, 6, 8, 9, 10]); // D,F,G,I,J,K
  const dateCols = new Set([2]); // C
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = worksheet[addr];
      if (!cell) continue;
      if (currencyCols.has(c) && typeof cell.v === 'number') {
        cell.s = { ...(cell.s || {}), numFmt: '$#,##0.00' };
      }
      if (dateCols.has(c) && cell.v instanceof Date) {
        cell.s = { ...(cell.s || {}), numFmt: 'yyyy-mm-dd' };
      }
    }
  }
}

function groupRowsByPayableMonth(rows: ExportRow[]) {
  const getPayableMonth = (r: ExportRow) => (r.payable_date || '').toString().substring(0, 7);
  const rowsByMonth: Record<string, ExportRow[]> = {};
  for (const r of rows) {
    const m = getPayableMonth(r);
    if (!rowsByMonth[m]) rowsByMonth[m] = [];
    rowsByMonth[m].push(r);
  }
  const sortedMonths = Object.keys(rowsByMonth).sort();
  return { rowsByMonth, sortedMonths, formatMonthHeading: formatMonthHeadingFromYyyyMm };
}

/**
 * GET /api/commission/batches/[id]/export
 * Download CSV or Excel for a batch (draft, approved, or paid).
 * Columns: Client, Deal, Payable date, Amount claimed on, Is renewal, Commission %, Original commission, Override amount, Final invoiced amount
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format') || 'csv';

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      const batch = db.prepare('SELECT * FROM commission_batches WHERE id = ?').get(id) as any;
      if (!batch) {
        return apiError('Batch not found', 404);
      }

      const canAccess = await canAccessBdr(batch.bdr_id);
      if (!canAccess) {
        return apiError('Forbidden', 403);
      }

      // Use snapshot for approved/paid (immutable)
      let rows: ExportRow[];
      if ((batch.status === 'approved' || batch.status === 'paid') as boolean) {
        const snapshot = db.prepare('SELECT snapshot_data FROM commission_batch_snapshots WHERE batch_id = ?').get(id) as { snapshot_data: string } | undefined;
        if (snapshot?.snapshot_data) {
          rows = JSON.parse(snapshot.snapshot_data) as ExportRow[];
        } else {
          rows = [];
        }
      } else {
        const items = db.prepare(`
        SELECT 
          cbi.override_amount,
          cbi.override_payment_date,
          cbi.override_commission_rate,
          ce.amount as original_amount,
          ce.payable_date,
          ce.accrual_date,
          d.client_name,
          d.service_type as deal_service_type,
          d.deal_value,
          d.original_deal_value,
          d.is_renewal as deal_is_renewal,
          ds.service_name,
          ds.commission_rate,
          ds.is_renewal as service_is_renewal,
          ds.original_service_value,
          ds.commissionable_value,
          re.billing_type as re_billing_type,
          re.collection_date,
          re.amount_collected
        FROM commission_batch_items cbi
        JOIN commission_entries ce ON cbi.commission_entry_id = ce.id
        JOIN deals d ON ce.deal_id = d.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        LEFT JOIN deal_services ds ON (re.service_id = ds.id OR ce.service_id = ds.id)
        WHERE cbi.batch_id = ?
      `).all(id) as any[];
        const { buildExportRows } = await import('@/lib/commission/export-rows');
        rows = buildExportRows(items);
      }

      const headers = [
        'Client',
        'Deal',
        'Payable date',
        'Amount claimed on',
        'Is renewal',
        'Previous deal amount',
        'New deal amount',
        'Commission %',
        'Original commission',
        'Override amount',
        'Final invoiced amount',
      ];

      const totalCommission = rows.reduce((sum: number, r) => sum + parseFloat(r.final_invoiced_amount || '0'), 0);

      const { rowsByMonth, sortedMonths, formatMonthHeading } = groupRowsByPayableMonth(rows);

      if (format === 'xlsx') {
        const worksheetData: Array<Array<string | number | Date | null>> = [headers];
        const rowTypes: ReportExcelRowType[] = ['header'];
        for (const month of sortedMonths) {
          const monthRows = rowsByMonth[month];
          const monthTotal = monthRows.reduce((s: number, r: ExportRow) => s + parseFloat(r.final_invoiced_amount || '0'), 0);
          worksheetData.push([`${formatMonthHeading(month)} — $${monthTotal.toFixed(2)}`, '', '', '', '', '', '', '', '', '', '']);
          rowTypes.push('month');
          for (const r of monthRows) {
            worksheetData.push([
              r.client_name,
              r.deal,
              toDateCell(r.payable_date),
              toNum(r.amount_claimed_on),
              r.is_renewal,
              toNum(r.previous_deal_amount),
              toNum(r.new_deal_amount),
              r.commission_pct,
              toNum(r.original_commission),
              toNum(r.override_amount),
              toNum(r.final_invoiced_amount),
            ]);
            rowTypes.push('data');
          }
        }
        worksheetData.push([]);
        rowTypes.push('blank');
        worksheetData.push(['TOTAL', '', '', '', '', '', '', '', '', '', totalCommission]);
        rowTypes.push('total');
        const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
        applyReportExcelStyles(worksheet, rowTypes);
        applyBatchReportNumFmt(worksheet);
        worksheet['!cols'] = [{ wch: 20 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 14 }];
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Commission Report');
        const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        const filename = `commission-report-${batch.run_date}-${id.slice(0, 8)}.xlsx`;
        return new Response(excelBuffer, {
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }

      const csvLines = [headers.join(',')];
      for (const month of sortedMonths) {
        const monthRows = rowsByMonth[month];
        const monthTotal = monthRows.reduce((s: number, r: ExportRow) => s + parseFloat(r.final_invoiced_amount || '0'), 0);
        csvLines.push([escapeCsvForReport(`${formatMonthHeading(month)} — $${monthTotal.toFixed(2)}`), '', '', '', '', '', '', '', '', '', ''].join(','));
        for (const r of monthRows) {
          csvLines.push(
            [
              escapeCsvForReport(r.client_name),
              escapeCsvForReport(r.deal),
              escapeCsvForReport(r.payable_date),
              r.amount_claimed_on,
              escapeCsvForReport(r.is_renewal),
              r.previous_deal_amount,
              r.new_deal_amount,
              escapeCsvForReport(r.commission_pct),
              r.original_commission,
              r.override_amount,
              r.final_invoiced_amount,
            ].join(',')
          );
        }
        csvLines.push('');
      }
      csvLines.push(['TOTAL', '', '', '', '', '', '', '', '', '', totalCommission.toFixed(2)].join(','));
      const csvContent = csvLines.join('\n');

      const filename = `commission-report-${batch.run_date}-${id.slice(0, 8)}.csv`;

      return new Response(csvContent, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // Supabase mode
    const supabase = await createClient();

    const { data: batch, error: batchError } = await supabase
      .from('commission_batches')
      .select('*')
      .eq('id', id)
      .single();

    if (batchError || !batch) {
      return apiError('Batch not found', 404);
    }

    const canAccess = await canAccessBdr(batch.bdr_id);
    if (!canAccess) {
      return apiError('Forbidden', 403);
    }

    let rows: ExportRow[];
    if (batch.status === 'approved' || batch.status === 'paid') {
      const { data: snapshot } = await supabase
        .from('commission_batch_snapshots')
        .select('snapshot_data')
        .eq('batch_id', id)
        .single();
      rows = snapshot?.snapshot_data ? (Array.isArray(snapshot.snapshot_data) ? snapshot.snapshot_data : (snapshot.snapshot_data as any)) : [];
    } else {
      const { data: batchItems } = await supabase
        .from('commission_batch_items')
        .select(`
          override_amount,
          override_payment_date,
          override_commission_rate,
          commission_entries(
            amount,
            payable_date,
            accrual_date,
            deals(client_name, service_type, deal_value, original_deal_value, is_renewal),
            revenue_events(billing_type, collection_date, amount_collected, deal_services(service_name, commission_rate, is_renewal, original_service_value, commissionable_value))
          )
        `)
        .eq('batch_id', id);

      const { buildExportRows, flattenSupabaseItem } = await import('@/lib/commission/export-rows');
      const flatItems = (batchItems || []).map((i: any) => flattenSupabaseItem(i));
      rows = buildExportRows(flatItems);
    }

    const headers = [
      'Client',
      'Deal',
      'Payable date',
      'Amount claimed on',
      'Is renewal',
      'Previous deal amount',
      'New deal amount',
      'Commission %',
      'Original commission',
      'Override amount',
      'Final invoiced amount',
    ];

    interface CsvRow {
      client_name: string;
      deal: string;
      payable_date: string;
      amount_claimed_on: string;
      is_renewal: string;
      previous_deal_amount: string;
      new_deal_amount: string;
      commission_pct: string;
      original_commission: string;
      override_amount: string;
      final_invoiced_amount: string;
    }

    const totalCommission = rows.reduce((sum: number, r: CsvRow) => sum + parseFloat(r.final_invoiced_amount || '0'), 0);

    const { rowsByMonth, sortedMonths, formatMonthHeading } = groupRowsByPayableMonth(rows as ExportRow[]);

    if (format === 'xlsx') {
      const worksheetData: Array<Array<string | number | Date | null>> = [headers];
      const rowTypes: ReportExcelRowType[] = ['header'];
      for (const month of sortedMonths) {
        const monthRows = rowsByMonth[month];
        const monthTotal = monthRows.reduce((s: number, r: ExportRow) => s + parseFloat(r.final_invoiced_amount || '0'), 0);
        worksheetData.push([`${formatMonthHeading(month)} — $${monthTotal.toFixed(2)}`, '', '', '', '', '', '', '', '', '', '']);
        rowTypes.push('month');
        for (const r of monthRows) {
          worksheetData.push([
            r.client_name,
            r.deal,
            toDateCell(r.payable_date),
            toNum(r.amount_claimed_on),
            r.is_renewal,
            toNum(r.previous_deal_amount),
            toNum(r.new_deal_amount),
            r.commission_pct,
            toNum(r.original_commission),
            toNum(r.override_amount),
            toNum(r.final_invoiced_amount),
          ]);
          rowTypes.push('data');
        }
      }
      worksheetData.push([]);
      rowTypes.push('blank');
      worksheetData.push(['TOTAL', '', '', '', '', '', '', '', '', '', totalCommission]);
      rowTypes.push('total');
      const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
      applyReportExcelStyles(worksheet, rowTypes);
      applyBatchReportNumFmt(worksheet);
      worksheet['!cols'] = [{ wch: 20 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 14 }];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Commission Report');
      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      const filename = `commission-report-${batch.run_date}-${id.slice(0, 8)}.xlsx`;
      return new Response(excelBuffer, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    const csvLinesSupabase = [headers.join(',')];
    for (const month of sortedMonths) {
      const monthRows = rowsByMonth[month];
      const monthTotal = monthRows.reduce((s: number, r: ExportRow) => s + parseFloat(r.final_invoiced_amount || '0'), 0);
      csvLinesSupabase.push([escapeCsvForReport(`${formatMonthHeading(month)} — $${monthTotal.toFixed(2)}`), '', '', '', '', '', '', '', '', '', ''].join(','));
      for (const r of monthRows) {
        csvLinesSupabase.push(
          [
            escapeCsvForReport(r.client_name),
            escapeCsvForReport(r.deal),
            escapeCsvForReport(r.payable_date),
            r.amount_claimed_on,
            escapeCsvForReport(r.is_renewal),
            r.previous_deal_amount,
            r.new_deal_amount,
            escapeCsvForReport(r.commission_pct),
            r.original_commission,
            r.override_amount,
            r.final_invoiced_amount,
          ].join(',')
        );
      }
      csvLinesSupabase.push('');
    }
    csvLinesSupabase.push(['TOTAL', '', '', '', '', '', '', '', '', '', totalCommission.toFixed(2)].join(','));
    const csvContent = csvLinesSupabase.join('\n');

    const filename = `commission-report-${batch.run_date}-${id.slice(0, 8)}.csv`;

    return new Response(csvContent, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error: any) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Commission batch export error:', error);
    }
    return apiError(error.message || 'Unauthorized', 401);
  }
}
