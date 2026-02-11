import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, requireAuth } from '@/lib/utils/api-helpers';
import * as XLSX from 'xlsx';

const USE_LOCAL_DB = process.env.USE_LOCAL_DB === 'true' || !process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * Export commission breakdown for finance approval
 * Returns Excel file with monthly summary and detailed breakdown
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const { searchParams } = new URL(request.url);
    const payableMonth = searchParams.get('payable_month'); // Optional: filter by specific month (YYYY-MM)
    const status = searchParams.get('status') || 'payable,pending'; // Default to payable and pending only

    const { isAdmin } = await import('@/lib/utils/auth');
    const isUserAdmin = await isAdmin();

    let entries: any[] = [];

    if (USE_LOCAL_DB) {
      const { getLocalDB } = await import('@/lib/db/local-db');
      const db = getLocalDB();

      // Build query to get all commission entries with full deal details
      // For renewals, join with original deal to get original proposal value
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
          d.is_renewal,
          d.original_deal_id,
          d.payout_months,
          re.amount_collected,
          re.collection_date,
          re.payment_stage,
          ds.service_name,
          ds.billing_type,
          ds.commission_rate,
          ds.commissionable_value,
          ds.commission_amount as service_commission_amount,
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

      query += ' ORDER BY COALESCE(ce.payable_date, ce.accrual_date, ce.month) ASC, br.name ASC, d.client_name ASC';

      const rawEntries = db.prepare(query).all(...params) as any[];
      
      // Map local DB results to include all fields
      // For renewals, use original_proposal_value from joined original deal, or original_deal_value, or current deal_value
      entries = rawEntries.map(entry => {
        const isRenewal = entry.is_renewal ? true : false;
        const originalProposalValue = isRenewal 
          ? (entry.original_proposal_value || entry.original_deal_value || entry.deal_value || 0)
          : (entry.deal_value || 0);
        
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
          payout_months: entry.payout_months || 12,
          amount_collected: entry.amount_collected || 0,
          collection_date: entry.collection_date || '',
          payment_stage: entry.payment_stage || '',
          service_name: entry.service_name || '',
          billing_type: entry.billing_type || '',
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
            deal_services(
              service_name,
              billing_type
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

      // Transform Supabase response to flat structure
      let allEntries = (data || []).map((entry: any) => {
        const revenueEvent = entry.revenue_events;
        const dealService = revenueEvent?.deal_services;
        
        // Handle array or single object for deal_services
        const serviceName = Array.isArray(dealService) 
          ? dealService[0]?.service_name 
          : dealService?.service_name;
        const billingType = Array.isArray(dealService)
          ? dealService[0]?.billing_type
          : dealService?.billing_type || revenueEvent?.billing_type;
        
        // For renewals, get original proposal value from original_deal_value or fetch from original deal
        const isRenewal = entry.deals?.is_renewal || false;
        let originalProposalValue = entry.deals?.deal_value || 0;
        
        if (isRenewal) {
          // For renewals, prefer original_deal_value if set, otherwise use deal_value as fallback
          originalProposalValue = entry.deals?.original_deal_value || entry.deals?.deal_value || 0;
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
          payout_months: entry.deals?.payout_months || 12,
          amount_collected: revenueEvent?.amount_collected || 0,
          collection_date: revenueEvent?.collection_date || '',
          payment_stage: revenueEvent?.payment_stage || '',
          service_name: serviceName || '',
          billing_type: billingType || '',
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
          monthData.totalAmount.toFixed(2),
          monthData.entryCount,
          Array.from(monthData.bdrBreakdown.entries())
            .map(([name, amount]) => `${name}: $${amount.toFixed(2)}`)
            .join('; ')
        ]);
      });

    // Add total row
    const grandTotal = entries.reduce((sum, e) => sum + Number(e.amount), 0);
    summaryData.push([]);
    summaryData.push(['GRAND TOTAL', grandTotal.toFixed(2), entries.length, '']);

    // Create workbook
    const workbook = XLSX.utils.book_new();
    
    // Add summary sheet
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Monthly Summary');

    // Create Deal Breakdown sheet - groups by deal to show all commission entries per deal
    const dealBreakdown = new Map<string, {
      deal_id: string;
      client_name: string;
      bdr_name: string;
      service_type: string;
      deal_value: number;
      original_proposal_value: number;
      is_renewal: boolean;
      close_date: string;
      total_commission: number;
      this_month_commission: number;
      entries: any[];
    }>();

    entries.forEach(entry => {
      const dealKey = entry.deal_id;
      const entryPayableMonth = entry.payable_date
        ? entry.payable_date.substring(0, 7)
        : entry.accrual_date
          ? entry.accrual_date.substring(0, 7)
          : entry.month
            ? (typeof entry.month === 'string' ? entry.month.substring(0, 7) : entry.month)
            : 'unknown';
      
      if (!dealBreakdown.has(dealKey)) {
        dealBreakdown.set(dealKey, {
          deal_id: entry.deal_id,
          client_name: entry.client_name,
          bdr_name: entry.bdr_name,
          service_type: entry.service_type,
          deal_value: Number(entry.deal_value || 0),
          original_proposal_value: Number(entry.original_proposal_value || entry.deal_value || 0),
          is_renewal: entry.is_renewal || false,
          close_date: entry.close_date || '',
          total_commission: 0,
          this_month_commission: 0,
          entries: [],
        });
      }

      const dealData = dealBreakdown.get(dealKey)!;
      const entryAmount = Number(entry.amount || 0);
      dealData.total_commission += entryAmount;
      
      // If this entry is for the filtered month (or if no month filter, count all)
      if (!payableMonth || entryPayableMonth === payableMonth) {
        dealData.this_month_commission += entryAmount;
      }
      
      dealData.entries.push(entry);
    });

    // Create simplified deal breakdown sheet data
    // For renewals: show uplift amount and note that commission is only on uplift
    const dealBreakdownHeaders = [
      'Client Name',
      'BDR Name',
      'Service Type',
      'Deal Value',
      'Original Proposal Value',
      'Uplift Amount (Renewals Only)',
      'Is Renewal',
      'Close Date',
      'Total Commission (All Months)',
      payableMonth ? `Commission (${payableMonth})` : 'Commission (This Export)',
    ];

    const dealBreakdownData: any[] = [dealBreakdownHeaders];

    Array.from(dealBreakdown.values())
      .sort((a, b) => a.client_name.localeCompare(b.client_name))
      .forEach(deal => {
        // Calculate uplift for renewals (renewal value - original value)
        const upliftAmount = deal.is_renewal 
          ? Math.max(0, deal.deal_value - deal.original_proposal_value)
          : 0;
        
        dealBreakdownData.push([
          deal.client_name,
          deal.bdr_name,
          deal.service_type,
          deal.deal_value.toFixed(2),
          deal.is_renewal ? deal.original_proposal_value.toFixed(2) : '',
          deal.is_renewal ? upliftAmount.toFixed(2) : '',
          deal.is_renewal ? 'Yes' : 'No',
          deal.close_date || '',
          deal.total_commission.toFixed(2),
          deal.this_month_commission.toFixed(2),
        ]);
      });

    const dealBreakdownSheet = XLSX.utils.aoa_to_sheet(dealBreakdownData);
    const dealColWidths = [
      { wch: 25 }, // Client Name
      { wch: 20 }, // BDR Name
      { wch: 20 }, // Service Type
      { wch: 15 }, // Deal Value
      { wch: 20 }, // Original Proposal Value
      { wch: 25 }, // Uplift Amount (Renewals Only)
      { wch: 12 }, // Is Renewal
      { wch: 12 }, // Close Date
      { wch: 25 }, // Total Commission (All Months)
      { wch: 25 }, // Commission (This Month/Export)
    ];
    dealBreakdownSheet['!cols'] = dealColWidths;
    
    XLSX.utils.book_append_sheet(workbook, dealBreakdownSheet, 'Deal Breakdown');

    // Generate Excel file buffer
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Generate filename with date
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = payableMonth
      ? `commissions-${payableMonth}-${dateStr}.xlsx`
      : `commissions-all-${dateStr}.xlsx`;

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

