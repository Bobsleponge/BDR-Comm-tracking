import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, requireAuth } from '@/lib/utils/api-helpers';
import * as XLSX from 'xlsx-js-style';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

function toDateCell(value?: string): Date | '' {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d;
}

function applyNumFmt(
  sheet: XLSX.WorkSheet,
  options: { currencyCols?: number[]; integerCols?: number[]; dateCols?: number[] }
) {
  const ref = sheet['!ref'];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  const currencyCols = new Set(options.currencyCols || []);
  const integerCols = new Set(options.integerCols || []);
  const dateCols = new Set(options.dateCols || []);

  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (!cell) continue;

      if (currencyCols.has(c) && typeof cell.v === 'number') {
        cell.s = { ...(cell.s || {}), numFmt: '$#,##0.00' };
      } else if (integerCols.has(c) && typeof cell.v === 'number') {
        cell.s = { ...(cell.s || {}), numFmt: '#,##0' };
      } else if (dateCols.has(c) && cell.v instanceof Date) {
        cell.s = { ...(cell.s || {}), numFmt: 'yyyy-mm-dd' };
      }
    }
  }
}

/**
 * Export commission breakdown for finance approval
 * Returns Excel file with monthly summary and detailed breakdown
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const payableMonth = searchParams.get('payable_month'); // Optional: filter by specific month (YYYY-MM)
    const payableCutoff = searchParams.get('payable_cutoff'); // Optional: for Comm Sheet - only include entries with payable_date <= this date (YYYY-MM-DD)
    const status = searchParams.get('status') || 'payable,pending'; // Default to payable and pending only

    const { isAdmin } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    let entries: any[] = [];

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Build query to get all commission entries with full deal and service details
      // For renewals: use deal.is_renewal OR deal_services.is_renewal (per-service tracking)
      // amount_collected = bill amount for this specific commission payment (e.g. $1000 for monthly bookkeeping)
      let query = `
        SELECT 
          ce.id,
          ce.amount,
          ce.status,
          ce.accrual_date,
          ce.payable_date,
          ce.month,
          br.name as bdr_name,
          br.email as bdr_email,
          d.id as deal_id,
          d.client_name,
          d.service_type,
          d.proposal_date,
          d.close_date,
          d.first_invoice_date,
          d.deal_value,
          d.original_deal_value,
          d.is_renewal as deal_is_renewal,
          d.original_deal_id,
          d.payout_months,
          re.amount_collected,
          re.collection_date,
          re.payment_stage,
          re.billing_type as re_billing_type,
          ds.id as service_id,
          ds.service_name,
          ds.service_type as ds_service_type,
          ds.billing_type,
          ds.commission_rate,
          ds.commissionable_value,
          ds.commission_amount as service_commission_amount,
          ds.is_renewal as service_is_renewal,
          ds.original_service_value,
          od.deal_value as original_proposal_value
        FROM commission_entries ce
        INNER JOIN deals d ON ce.deal_id = d.id
        INNER JOIN bdr_reps br ON ce.bdr_id = br.id
        LEFT JOIN revenue_events re ON ce.revenue_event_id = re.id
        LEFT JOIN deal_services ds ON re.service_id = ds.id
        LEFT JOIN deals od ON d.original_deal_id = od.id
        WHERE d.cancellation_date IS NULL
          AND ce.status IN ('payable', 'pending', 'accrued')
      `;
      const params: any[] = [];

      if (payableMonth) {
        query += " AND strftime('%Y-%m', COALESCE(ce.payable_date, ce.accrual_date, ce.month)) = ?";
        params.push(payableMonth);
      }

      // Comm Sheet: only include entries with payable date on or before cutoff (e.g. today)
      if (payableCutoff) {
        query += " AND COALESCE(ce.payable_date, ce.accrual_date, ce.month || '-01') <= ?";
        params.push(payableCutoff);
      }

      query += ' ORDER BY COALESCE(ce.payable_date, ce.accrual_date, ce.month) ASC, br.name ASC, d.client_name ASC';

      const rawEntries = db.prepare(query).all(...params) as any[];
      
      // Map local DB results - use service-level is_renewal when we have a service, else deal-level
      entries = rawEntries.map(entry => {
        const serviceIsRenewal = entry.service_id && (entry.service_is_renewal === 1 || entry.service_is_renewal === true);
        const dealIsRenewal = entry.deal_is_renewal === 1 || entry.deal_is_renewal === true;
        const isRenewal = serviceIsRenewal || dealIsRenewal || entry.re_billing_type === 'renewal';
        const originalProposalValue = isRenewal 
          ? (entry.original_proposal_value || entry.original_deal_value || entry.deal_value || 0)
          : (entry.deal_value || 0);
        const serviceName = entry.service_name || entry.service_type || 'Service';
        const billingType = entry.billing_type || entry.re_billing_type || '';

        let previousDealAmount = 0;
        let newDealAmount = 0;
        if (isRenewal) {
          const storedNew = entry.commissionable_value ?? entry.deal_value ?? 0;
          const storedPrev = entry.original_service_value ?? entry.original_deal_value;
          const uplift = Number(entry.amount_collected ?? 0);
          if (entry.re_billing_type === 'renewal' && uplift > 0 && storedNew > 0) {
            const numNew = Number(storedNew);
            if (storedPrev == null || Number(storedPrev) === numNew) {
              previousDealAmount = Math.max(0, numNew - uplift);
              newDealAmount = numNew;
            } else {
              previousDealAmount = Number(storedPrev ?? 0);
              newDealAmount = numNew;
            }
          } else if (entry.service_id && (entry.original_service_value != null || entry.commissionable_value != null)) {
            previousDealAmount = Number(entry.original_service_value ?? 0);
            newDealAmount = Number(entry.commissionable_value ?? 0);
          } else {
            previousDealAmount = Number(entry.original_deal_value ?? 0);
            newDealAmount = Number(entry.deal_value ?? 0);
          }
        }
        
        return {
          id: entry.id,
          amount: entry.amount,
          status: entry.status,
          accrual_date: entry.accrual_date,
          payable_date: entry.payable_date,
          month: entry.month,
          bdr_name: entry.bdr_name || '',
          bdr_email: entry.bdr_email || '',
          deal_id: entry.deal_id || '',
          client_name: entry.client_name || '',
          service_type: entry.service_type || '',
          proposal_date: entry.proposal_date || '',
          close_date: entry.close_date || '',
          first_invoice_date: entry.first_invoice_date || '',
          deal_value: entry.deal_value || 0,
          original_proposal_value: originalProposalValue,
          is_renewal: isRenewal,
          previous_deal_amount: previousDealAmount,
          new_deal_amount: newDealAmount,
          payout_months: entry.payout_months || 12,
          amount_collected: entry.amount_collected ?? 0,
          collection_date: entry.collection_date || '',
          payment_stage: entry.payment_stage || '',
          service_name: serviceName,
          billing_type: billingType,
        };
      });
    } else {
      // Supabase mode
      const supabase = await createClient();

      let query: any = (supabase as any)
        .from('commission_entries')
        .select(`
          id,
          amount,
          status,
          accrual_date,
          payable_date,
          month,
          bdr_reps!inner(name, email),
          deals!inner(
            id,
            client_name,
            service_type,
            proposal_date,
            close_date,
            first_invoice_date,
            deal_value,
            original_deal_value,
            is_renewal,
            original_deal_id,
            payout_months,
            cancellation_date
          ),
          revenue_events(
            amount_collected,
            collection_date,
            payment_stage,
            billing_type,
            deal_services(
              service_name,
              billing_type,
              is_renewal,
              original_service_value,
              commissionable_value
            )
          )
        `)
        .is('deals.cancellation_date', null)
        .in('status', ['payable', 'pending', 'accrued'])
        .order('payable_date', { ascending: true, nullsFirst: true })
        .order('accrual_date', { ascending: true, nullsFirst: true })
        .order('month', { ascending: true });

      const { data, error } = (await query) as { data: any[] | null; error: any };

      if (error) {
        return apiError(error.message || 'Failed to fetch commission entries', 500);
      }

      // Transform Supabase response - use service-level is_renewal when available, else deal-level
      let allEntries = (data || []).map((entry: any) => {
        const revenueEvent = entry.revenue_events;
        const dealService = revenueEvent?.deal_services;
        
        const serviceObj = Array.isArray(dealService) ? dealService[0] : dealService;
        const serviceName = serviceObj?.service_name || entry.deals?.service_type || 'Service';
        const billingType = serviceObj?.billing_type || revenueEvent?.billing_type || '';
        const serviceIsRenewal = serviceObj?.is_renewal === true;
        const dealIsRenewal = entry.deals?.is_renewal || false;
        const isRenewal = serviceIsRenewal || dealIsRenewal || revenueEvent?.billing_type === 'renewal';
        
        let originalProposalValue = entry.deals?.deal_value || 0;
        if (isRenewal) {
          originalProposalValue = entry.deals?.original_deal_value ?? entry.deals?.deal_value ?? 0;
        }

        let previousDealAmount = 0;
        let newDealAmount = 0;
        if (isRenewal) {
          const storedNew = serviceObj?.commissionable_value ?? entry.deals?.deal_value ?? 0;
          const storedPrev = serviceObj?.original_service_value ?? entry.deals?.original_deal_value;
          const uplift = Number(revenueEvent?.amount_collected ?? 0);
          if (revenueEvent?.billing_type === 'renewal' && uplift > 0 && storedNew > 0) {
            const numNew = Number(storedNew);
            if (storedPrev == null || Number(storedPrev) === numNew) {
              previousDealAmount = Math.max(0, numNew - uplift);
              newDealAmount = numNew;
            } else {
              previousDealAmount = Number(storedPrev ?? 0);
              newDealAmount = numNew;
            }
          } else if (serviceObj && (serviceObj.original_service_value != null || serviceObj.commissionable_value != null)) {
            previousDealAmount = Number(serviceObj.original_service_value ?? 0);
            newDealAmount = Number(serviceObj.commissionable_value ?? 0);
          } else {
            previousDealAmount = Number(entry.deals?.original_deal_value ?? 0);
            newDealAmount = Number(entry.deals?.deal_value ?? 0);
          }
        }
        
        return {
          id: entry.id,
          amount: entry.amount,
          status: entry.status,
          accrual_date: entry.accrual_date,
          payable_date: entry.payable_date,
          month: entry.month,
          bdr_name: entry.bdr_reps?.name || '',
          bdr_email: entry.bdr_reps?.email || '',
          deal_id: entry.deals?.id || '',
          client_name: entry.deals?.client_name || '',
          service_type: entry.deals?.service_type || '',
          proposal_date: entry.deals?.proposal_date || '',
          close_date: entry.deals?.close_date || '',
          first_invoice_date: entry.deals?.first_invoice_date || '',
          deal_value: entry.deals?.deal_value || 0,
          original_proposal_value: originalProposalValue,
          is_renewal: isRenewal,
          previous_deal_amount: previousDealAmount,
          new_deal_amount: newDealAmount,
          payout_months: entry.deals?.payout_months || 12,
          amount_collected: revenueEvent?.amount_collected ?? 0,
          collection_date: revenueEvent?.collection_date || '',
          payment_stage: revenueEvent?.payment_stage || '',
          service_name: serviceName,
          billing_type: billingType,
        };
      });

      // Filter by payable month if specified (after fetching to handle multiple date fields)
      if (payableMonth) {
        allEntries = allEntries.filter(entry => {
          const entryMonth = entry.payable_date
            ? entry.payable_date.substring(0, 7)
            : entry.accrual_date
              ? entry.accrual_date.substring(0, 7)
              : entry.month
                ? (typeof entry.month === 'string' ? entry.month.substring(0, 7) : entry.month)
                : null;
          return entryMonth === payableMonth;
        });
      }

      // Comm Sheet: only include entries with payable date on or before cutoff (e.g. today)
      if (payableCutoff) {
        allEntries = allEntries.filter(entry => {
          const effectiveDate = entry.payable_date
            || entry.accrual_date
            || (entry.month ? (typeof entry.month === 'string' ? entry.month + '-01' : String(entry.month) + '-01') : null);
          return effectiveDate && effectiveDate <= payableCutoff;
        });
      }

      entries = allEntries;
    }

    // Group entries by payable month for summary
    const monthlySummary = new Map<string, {
      month: string;
      totalAmount: number;
      entryCount: number;
      bdrBreakdown: Map<string, number>;
    }>();

    entries.forEach(entry => {
      const payableMonth = entry.payable_date
        ? entry.payable_date.substring(0, 7) // YYYY-MM format
        : entry.accrual_date
          ? entry.accrual_date.substring(0, 7)
          : entry.month
            ? (typeof entry.month === 'string' ? entry.month.substring(0, 7) : entry.month)
            : 'unknown';

      if (!monthlySummary.has(payableMonth)) {
        monthlySummary.set(payableMonth, {
          month: payableMonth,
          totalAmount: 0,
          entryCount: 0,
          bdrBreakdown: new Map(),
        });
      }

      const monthData = monthlySummary.get(payableMonth)!;
      monthData.totalAmount += Number(entry.amount);
      monthData.entryCount += 1;

      const bdrName = entry.bdr_name || 'Unknown';
      monthData.bdrBreakdown.set(
        bdrName,
        (monthData.bdrBreakdown.get(bdrName) || 0) + Number(entry.amount)
      );
    });

    // Create summary sheet data
    const summaryData: any[] = [];
    summaryData.push(['Month', 'Total Amount', 'Entry Count', 'BDR Breakdown']);
    
    Array.from(monthlySummary.values())
      .sort((a, b) => a.month.localeCompare(b.month))
      .forEach(monthData => {
        summaryData.push([
          monthData.month,
          monthData.totalAmount,
          monthData.entryCount,
          Array.from(monthData.bdrBreakdown.entries())
            .map(([name, amount]) => `${name}: $${amount.toFixed(2)}`)
            .join('; ')
        ]);
      });

    // Add total row
    const grandTotal = entries.reduce((sum, e) => sum + Number(e.amount), 0);
    summaryData.push([]);
    summaryData.push(['GRAND TOTAL', grandTotal, entries.length, '']);

    // Create workbook
    const workbook = XLSX.utils.book_new();
    
    // Add summary sheet
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    applyNumFmt(summarySheet, { currencyCols: [1], integerCols: [2] });
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Monthly Summary');

    // Create Service Commission Detail sheet - one row per commission entry (each billed service payment)
    // Shows: each service, amount claimed on (money expected in account), commission earned, renewal status
    const detailHeaders = [
      'Client Name',
      'BDR Name',
      'Service Name',
      'Billing Type',
      'Payable Date',
      'Amount claimed on',
      'Commission (This Period)',
      'Is renewal',
      'Previous deal amount',
      'New deal amount',
      'Close Date',
      'Deal Value',
      'Status',
    ];

    const detailData: Array<Array<string | number | Date | null>> = [detailHeaders];

    entries
      .sort((a, b) => {
        const monthA = a.payable_date?.substring(0, 7) || a.accrual_date?.substring(0, 7) || a.month?.substring?.(0, 7) || '';
        const monthB = b.payable_date?.substring(0, 7) || b.accrual_date?.substring(0, 7) || b.month?.substring?.(0, 7) || '';
        if (monthA !== monthB) return monthA.localeCompare(monthB);
        if (a.client_name !== b.client_name) return a.client_name.localeCompare(b.client_name);
        return (a.service_name || '').localeCompare(b.service_name || '');
      })
      .forEach(entry => {
        // Payable date: use stored payable_date, else derive from close_date + 7 days
        let payableDate = entry.payable_date || entry.accrual_date || '';
        if (!payableDate && entry.close_date) {
          const d = new Date(entry.close_date);
          d.setDate(d.getDate() + 7);
          payableDate = d.toISOString().split('T')[0];
        }
        const billAmount = Number(entry.amount_collected ?? 0);
        const commissionAmount = Number(entry.amount ?? 0);
        
        const prevAmount = Number(entry.previous_deal_amount ?? 0);
        const newAmount = Number(entry.new_deal_amount ?? 0);
        detailData.push([
          entry.client_name || '',
          entry.bdr_name || '',
          entry.service_name || entry.service_type || 'Service',
          entry.billing_type || '',
          toDateCell(payableDate),
          billAmount > 0 ? billAmount : null,
          commissionAmount,
          entry.is_renewal ? 'Yes' : 'No',
          entry.is_renewal && prevAmount > 0 ? prevAmount : null,
          entry.is_renewal && newAmount > 0 ? newAmount : null,
          toDateCell(entry.close_date || ''),
          Number(entry.deal_value || 0),
          entry.status || '',
        ]);
      });

    // Add total row to Service Commission Detail sheet (Commission column is index 6)
    const detailTotal = entries.reduce((sum, e) => sum + Number(e.amount ?? 0), 0);
    detailData.push([]);
    detailData.push([
      'TOTAL',
      '',
      '',
      '',
      '',
      '',
      detailTotal,
      '',
      '',
      '',
      '',
      '',
      '',
    ]);

    const detailSheet = XLSX.utils.aoa_to_sheet(detailData);
    const detailColWidths = [
      { wch: 25 }, // Client Name
      { wch: 20 }, // BDR Name
      { wch: 25 }, // Service Name
      { wch: 14 }, // Billing Type
      { wch: 12 }, // Payable Date
      { wch: 18 }, // Amount claimed on
      { wch: 22 }, // Commission (This Period)
      { wch: 10 }, // Is renewal
      { wch: 18 }, // Previous deal amount
      { wch: 16 }, // New deal amount
      { wch: 12 }, // Close Date
      { wch: 12 }, // Deal Value
      { wch: 10 }, // Status
    ];
    detailSheet['!cols'] = detailColWidths;
    applyNumFmt(detailSheet, { currencyCols: [5, 6, 8, 9, 11], dateCols: [4, 10] });
    
    XLSX.utils.book_append_sheet(workbook, detailSheet, 'Service Commission Detail');

    // Generate Excel file buffer
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Generate filename with date
    const dateStr = new Date().toISOString().split('T')[0];
    let filename: string;
    if (payableCutoff && payableMonth) {
      filename = `comm-sheet-${payableMonth}-as-of-${payableCutoff}.xlsx`;
    } else if (payableMonth) {
      filename = `commissions-${payableMonth}-${dateStr}.xlsx`;
    } else {
      filename = `commissions-all-${dateStr}.xlsx`;
    }

    // Return Excel file
    return new Response(excelBuffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error: any) {
    console.error('Export error:', error);
    return apiError(error.message || 'Failed to export commissions', 500);
  }
}

