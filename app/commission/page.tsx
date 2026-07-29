'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { CommissionSummary } from '@/components/commission/CommissionSummary';
import { CommissionEntriesTable } from '@/components/commission/CommissionEntriesTable';
import { CommissionBreakdown } from '@/components/commission/CommissionBreakdown';
import { CommissionVerification } from '@/components/commission/CommissionVerification';
import { exportCommissionToCSV } from '@/lib/utils/csv-export';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FileText, Plus, Undo2, Banknote } from 'lucide-react';

interface CommissionSummary {
  earned: number;
  pending: number;
  cancelled: number;
  total: number;
}

interface CommissionEntry {
  id: string;
  month: string;
  amount: number | null;
  status: 'pending' | 'paid' | 'cancelled';
  deals?: {
    client_name: string;
    service_type: string;
  };
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  const { safeJsonParse } = await import('@/lib/utils/client-helpers');
  const data = await safeJsonParse(res);
  if (!res.ok || data.error) {
    throw new Error(data.error || `Failed to fetch: ${res.statusText}`);
  }
  return data;
};

export default function CommissionPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<CommissionSummary | null>(null);
  const [entries, setEntries] = useState<CommissionEntry[]>([]);
  const [breakdown, setBreakdown] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState<string>('all');
  
  const [reprocessing, setReprocessing] = useState(false);
  const [generateReportLoading, setGenerateReportLoading] = useState(false);
  const [generateReportOpen, setGenerateReportOpen] = useState(false);
  const [reportPayableCutoff, setReportPayableCutoff] = useState(() => new Date().toISOString().split('T')[0]);
  const [eligiblePreviewCount, setEligiblePreviewCount] = useState<number | null>(null);
  const [eligiblePreviewLoading, setEligiblePreviewLoading] = useState(false);
  const [unapprovingId, setUnapprovingId] = useState<string | null>(null);
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'table' | 'breakdown' | 'verify'>('breakdown');
  const [filters, setFilters] = useState<{ serviceType?: string; billingType?: string }>({});

  // Payable months are data-driven: any month with a commission entry (including far future, e.g. Aug 2027)
  const getAvailableMonths = (): string[] => {
    if (Array.isArray(breakdown?.payableMonths) && breakdown.payableMonths.length > 0) {
      return breakdown.payableMonths;
    }
    if (breakdown?.breakdown?.length) {
      return breakdown.breakdown
        .map((m: { month: string }) => m.month)
        .filter((m: string) => m && m !== 'unknown')
        .sort();
    }
    return [];
  };

  const formatMonthLabel = (monthStr: string) => {
    const [year, month] = monthStr.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const formatMoneyShort = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const monthLabelWithApproval = (monthStr: string) => {
    const base = formatMonthLabel(monthStr);
    const rows = breakdown?.breakdown as
      | Array<{ month: string; entries?: Array<{ isApproved?: boolean; status?: string; amount: number }> }>
      | undefined;
    const row = rows?.find((m) => m.month === monthStr);
    if (!row?.entries?.length) return base;
    const settled = (e: { isApproved?: boolean; status?: string; amount: number }) =>
      e.status === 'paid' || e.isApproved === true;
    const approved = row.entries.filter(settled).reduce((s, e) => s + Number(e.amount ?? 0), 0);
    const left = row.entries.filter((e) => !settled(e)).reduce((s, e) => s + Number(e.amount ?? 0), 0);
    return `${base} · $${formatMoneyShort(approved)} approved · $${formatMoneyShort(left)} left`;
  };

  // Check admin status once using API
  useSWR('/api/auth/user', fetcher, {
    onSuccess: (data) => {
      if (data?.role === 'admin') {
        setIsAdmin(true);
      }
    },
    revalidateOnFocus: false,
  });

  // Use SWR for data fetching with automatic caching and revalidation

  const entriesUrl = selectedMonth && selectedMonth !== 'all'
    ? `/api/commission/entries?payable_month=${selectedMonth}&include_report_adjustments=1&limit=5000`
    : '/api/commission/entries?include_report_adjustments=1&limit=5000';
  
  const breakdownParams = new URLSearchParams();
  if (filters.serviceType) breakdownParams.append('service_type', filters.serviceType);
  if (filters.billingType) breakdownParams.append('billing_type', filters.billingType);
  const breakdownUrl = `/api/commission/breakdown?${breakdownParams.toString()}`;

  // Prioritize summary first (fastest, most important)
  const { data: summaryData, error: summaryError, mutate: mutateSummary } = useSWR('/api/commission/summary', fetcher, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    dedupingInterval: 0,
  });

  // Load entries and breakdown in parallel but with lower priority
  const { data: entriesData, error: entriesError, mutate: mutateEntries } = useSWR(entriesUrl, fetcher, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    dedupingInterval: 0,
  });

  const { data: breakdownData, error: breakdownError, mutate: mutateBreakdown } = useSWR(breakdownUrl, fetcher, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    dedupingInterval: 0,
  });

  const { data: batchesData, mutate: mutateBatches } = useSWR('/api/commission/batches', fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10000,
  });

  const batches = batchesData?.data ?? [];

  const handleMarkBatchPaid = async (batchId: string) => {
    if (!confirm('Mark this report as paid? Commission lines will show as paid in the system.')) return;
    setMarkingPaidId(batchId);
    try {
      const res = await fetch(`/api/commission/batches/${batchId}/mark-paid`, {
        method: 'POST',
        credentials: 'include',
      });
      const { safeJsonParse } = await import('@/lib/utils/client-helpers');
      const data = await safeJsonParse(res);
      if (!res.ok || data?.error) {
        throw new Error(data?.error || 'Failed to mark as paid');
      }
      mutateBatches();
      mutateSummary();
      mutateEntries();
      mutateBreakdown();
    } catch (err: any) {
      alert(err.message || 'Failed to mark as paid');
    } finally {
      setMarkingPaidId(null);
    }
  };

  const handleUnapprove = async (batchId: string) => {
    if (!confirm('Revert this report to draft? You will be able to edit it and approve again after fixing any issues.')) return;
    setUnapprovingId(batchId);
    try {
      const res = await fetch(`/api/commission/batches/${batchId}/unapprove`, {
        method: 'POST',
        credentials: 'include',
      });
      const { safeJsonParse } = await import('@/lib/utils/client-helpers');
      const data = await safeJsonParse(res);
      if (!res.ok || data?.error) {
        throw new Error(data?.error || 'Failed to revert to draft');
      }
      mutateBatches();
      mutateSummary();
      mutateEntries();
      mutateBreakdown();
    } catch (err: any) {
      alert(err.message || 'Failed to revert to draft');
    } finally {
      setUnapprovingId(null);
    }
  };

  const fetchEligiblePreview = useCallback(async (cutoff: string) => {
    setEligiblePreviewLoading(true);
    try {
      const res = await fetch(`/api/commission/eligible?payable_cutoff=${encodeURIComponent(cutoff)}`, {
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        setEligiblePreviewCount(null);
        return;
      }
      setEligiblePreviewCount(data.count ?? data.data?.length ?? 0);
    } catch {
      setEligiblePreviewCount(null);
    } finally {
      setEligiblePreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!generateReportOpen) return;
    fetchEligiblePreview(reportPayableCutoff);
  }, [generateReportOpen, reportPayableCutoff, fetchEligiblePreview]);

  const handleOpenGenerateReport = () => {
    setReportPayableCutoff(new Date().toISOString().split('T')[0]);
    setEligiblePreviewCount(null);
    setGenerateReportOpen(true);
  };

  const handleGenerateReport = async () => {
    if (!reportPayableCutoff) {
      alert('Please choose a payable-through date');
      return;
    }
    setGenerateReportLoading(true);
    try {
      const res = await fetch('/api/commission/batches', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payable_cutoff: reportPayableCutoff }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate report');
      }
      setGenerateReportOpen(false);
      mutateBatches();
      mutateSummary();
      mutateEntries();
      mutateBreakdown();
      router.push(`/commission/batches/${data.id}`);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setGenerateReportLoading(false);
    }
  };

  const formatCutoffLabel = (dateStr: string) => {
    const [y, m, d] = dateStr.split('-');
    return new Date(parseInt(y), parseInt(m) - 1, parseInt(d || '1')).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatRunDate = (dateStr: string) => {
    if (!dateStr) return '—';
    const [y, m, d] = dateStr.split('-');
    return new Date(parseInt(y), parseInt(m) - 1, parseInt(d || '1')).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // Progressive loading - show data as it arrives, don't wait for everything
  useEffect(() => {
    if (summaryData) setSummary(summaryData);
    if (entriesData) {
      // Extract entries array from paginated response
      const entriesArray = Array.isArray(entriesData) 
        ? entriesData 
        : (entriesData?.data || []);
      setEntries(entriesArray);
    }
    if (breakdownData) setBreakdown(breakdownData);
    
    const hasError = summaryError || entriesError || breakdownError;
    if (hasError) {
      setError(hasError.message || 'Failed to load commission data');
    }
    
    // Only show loading if we have NO data at all
    const isLoading = !summaryData && !summaryError && !entriesData && !entriesError && !breakdownData && !breakdownError;
    setLoading(isLoading);
  }, [summaryData, entriesData, breakdownData, summaryError, entriesError, breakdownError]);

  const handleMarkPaid = async (id: string) => {
    try {
      const res = await fetch(`/api/commission/entries/${id}/mark-paid`, {
        method: 'PATCH',
      });

      if (!res.ok) throw new Error('Failed to mark as paid');

      // Revalidate both endpoints to refresh data
      mutateEntries();
      mutateSummary();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const [reprocessCloseMonth, setReprocessCloseMonth] = useState<string>('2025-12');

  const handleReprocessAllDeals = async () => {
    if (!isAdmin) return;
    const scope = reprocessCloseMonth && reprocessCloseMonth !== 'all' 
      ? `deals closed in ${reprocessCloseMonth}` 
      : 'all closed-won deals';
    if (!confirm(`This will reprocess ${scope} to create revenue events and commission entries. Continue?`)) {
      return;
    }

    setReprocessing(true);
    try {
      const url = reprocessCloseMonth && reprocessCloseMonth !== 'all'
        ? `/api/deals/reprocess-all?close_month=${reprocessCloseMonth}` 
        : '/api/deals/reprocess-all';
      const res = await fetch(url, {
        method: 'POST',
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to start reprocessing');
      }

      const result = await res.json();
      alert(`Reprocessing started: ${result.message}`);
      
      // Refresh data after a short delay
      setTimeout(() => {
        mutateSummary();
        mutateEntries();
        mutateBreakdown();
      }, 2000);
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setReprocessing(false);
    }
  };

  const handleExportForFinance = async () => {
    try {
      // Build export URL with optional month filter
      let exportUrl = '/api/commission/export';
      if (selectedMonth && selectedMonth !== 'all') {
        exportUrl += `?payable_month=${selectedMonth}`;
      }

      const res = await fetch(exportUrl, {
        credentials: 'include',
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to export commissions');
      }

      // Get the blob and trigger download
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      // Extract filename from Content-Disposition header or use default
      const contentDisposition = res.headers.get('Content-Disposition');
      let filename = 'commissions-export.xlsx';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="(.+)"/);
        if (filenameMatch) {
          filename = filenameMatch[1];
        }
      }
      
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Error exporting: ${err.message}`);
    }
  };

  // Get display text for export button based on selected month
  const getExportButtonText = () => {
    if (selectedMonth && selectedMonth !== 'all') {
      return `Export ${formatMonthLabel(selectedMonth)} for Finance`;
    }
    return 'Export All Months for Finance';
  };

  // Show loading only if we have absolutely no data
  const showFullLoading = loading && !summary && entries.length === 0 && !breakdown;

  const displayBreakdown =
    selectedMonth && selectedMonth !== 'all' && breakdown?.breakdown
      ? breakdown.breakdown.filter((m: { month: string }) => m.month === selectedMonth)
      : breakdown?.breakdown || [];

  const displayBreakdownTotal = displayBreakdown.reduce(
    (sum: number, m: { totalAmount: number }) => sum + Number(m.totalAmount ?? 0),
    0
  );

  return (
    <ErrorBoundary>
      <AuthGuard>
        <Layout>
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6 flex justify-between items-center">
            <h2 className="text-2xl font-bold">Commission Tracking</h2>
            <div className="flex gap-2">
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <Select value={reprocessCloseMonth} onValueChange={setReprocessCloseMonth}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="Deals closed in..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2025-12">December 2025</SelectItem>
                      <SelectItem value="2026-01">January 2026</SelectItem>
                      <SelectItem value="all">All months</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={handleReprocessAllDeals}
                    disabled={reprocessing}
                    variant="outline"
                  >
                    {reprocessing ? 'Reprocessing...' : 'Reprocess Deals'}
                  </Button>
                </div>
              )}
              <Button variant="outline" onClick={() => exportCommissionToCSV(entries)}>
                Export CSV
              </Button>
              <Button variant="default" onClick={handleExportForFinance} title={selectedMonth && selectedMonth !== 'all' ? `Exporting commissions for ${formatMonthLabel(selectedMonth)}` : 'Exporting all commissions'}>
                {getExportButtonText()}
              </Button>
            </div>
          </div>

          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>Error: {error}</AlertDescription>
            </Alert>
          )}

          <div className="mb-6">
            <Label htmlFor="month-select" className="mb-2">
              Filter by Payable Month (Export will use this selection)
            </Label>
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger id="month-select" className="w-[250px]">
                <SelectValue placeholder="All Months" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Months</SelectItem>
                {getAvailableMonths().map((month) => (
                  <SelectItem key={month} value={month}>
                    {monthLabelWithApproval(month)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Progressive loading - show summary first, then other data */}
          {showFullLoading ? (
            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-32" />
                ))}
              </div>
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <>
              {summary ? (
                <div className="mb-6">
                  <CommissionSummary
                    earned={summary.earned}
                    pending={summary.pending}
                    cancelled={summary.cancelled}
                    total={summary.total}
                  />
                </div>
              ) : (
                <div className="mb-6">
                  <Skeleton className="h-32 w-full" />
                </div>
              )}

              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    My Commission Reports
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Draft → adjust line items and overrides → Approve and Finalize → Mark as Paid when sent.
                    Use Adjust on an approved report to revert to draft if you need to fix something before paying.
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <Button
                      onClick={handleOpenGenerateReport}
                      disabled={generateReportLoading}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Generate My Commission Report
                    </Button>
                    <Dialog open={generateReportOpen} onOpenChange={setGenerateReportOpen}>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Generate Commission Report</DialogTitle>
                          <DialogDescription>
                            Choose the last payable date to include. Only entries with a payable date on or
                            before this date will be pulled into the report — for example, use May 31 when
                            preparing your May invoice.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-2 py-2">
                          <Label htmlFor="report-payable-cutoff">Include commissions payable through</Label>
                          <Input
                            id="report-payable-cutoff"
                            type="date"
                            value={reportPayableCutoff}
                            onChange={(e) => setReportPayableCutoff(e.target.value)}
                          />
                          <p className="text-sm text-muted-foreground">
                            {eligiblePreviewLoading
                              ? 'Checking eligible entries...'
                              : eligiblePreviewCount != null
                                ? `${eligiblePreviewCount} eligible ${eligiblePreviewCount === 1 ? 'entry' : 'entries'} payable on or before ${formatCutoffLabel(reportPayableCutoff)}`
                                : `Entries payable on or before ${formatCutoffLabel(reportPayableCutoff)} will be included`}
                          </p>
                        </div>
                        <DialogFooter>
                          <Button variant="outline" onClick={() => setGenerateReportOpen(false)}>
                            Cancel
                          </Button>
                          <Button onClick={handleGenerateReport} disabled={generateReportLoading || !reportPayableCutoff}>
                            {generateReportLoading ? 'Generating...' : 'Generate Report'}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                    {batches.length > 0 && (
                      <div>
                        <h4 className="text-sm font-medium mb-2">Recent Reports</h4>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Run Date</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Items</TableHead>
                              <TableHead>Total</TableHead>
                              <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {batches.slice(0, 10).map((b: any) => (
                              <TableRow key={b.id}>
                                <TableCell>{formatRunDate(b.run_date)}</TableCell>
                                <TableCell>
                                  <Badge
                                    variant={
                                      b.status === 'draft'
                                        ? 'secondary'
                                        : b.status === 'paid'
                                          ? 'default'
                                          : 'outline'
                                    }
                                  >
                                    {b.status}
                                  </Badge>
                                </TableCell>
                                <TableCell>{b.item_count ?? 0}</TableCell>
                                <TableCell>${Number(b.total_amount ?? 0).toFixed(2)}</TableCell>
                                <TableCell className="text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    {b.status === 'approved' && (
                                      <>
                                        <Button
                                          variant="default"
                                          size="sm"
                                          onClick={(e) => {
                                            e.preventDefault();
                                            handleMarkBatchPaid(b.id);
                                          }}
                                          disabled={!!markingPaidId || !!unapprovingId}
                                          title="Record that payment was sent"
                                        >
                                          <Banknote className="mr-1 h-3.5 w-3.5" />
                                          {markingPaidId === b.id ? 'Marking...' : 'Mark Paid'}
                                        </Button>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={(e) => {
                                            e.preventDefault();
                                            handleUnapprove(b.id);
                                          }}
                                          disabled={!!unapprovingId || !!markingPaidId}
                                          title="Revert to draft to adjust, then approve again"
                                        >
                                          <Undo2 className="mr-1 h-3.5 w-3.5" />
                                          {unapprovingId === b.id ? 'Reverting...' : 'Adjust'}
                                        </Button>
                                      </>
                                    )}
                                    <Link href={`/commission/batches/${b.id}`}>
                                      <Button variant="ghost" size="sm">
                                        {b.status === 'draft' ? 'Edit' : 'View'}
                                      </Button>
                                    </Link>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'table' | 'breakdown' | 'verify')} className="mb-6">
                <TabsList>
                  <TabsTrigger value="breakdown">Monthly Breakdown</TabsTrigger>
                  <TabsTrigger value="table">All Entries</TabsTrigger>
                  <TabsTrigger value="verify">Verification</TabsTrigger>
                </TabsList>
                <TabsContent value="breakdown">
                  {breakdown ? (
                    <CommissionBreakdown
                      breakdown={displayBreakdown}
                      total={selectedMonth !== 'all' ? displayBreakdownTotal : breakdown.total || 0}
                      onFilterChange={(newFilters) => {
                        setFilters(newFilters);
                      }}
                    />
                  ) : (
                    <Skeleton className="h-64 w-full" />
                  )}
                </TabsContent>
                <TabsContent value="verify">
                  <CommissionVerification />
                </TabsContent>
                <TabsContent value="table">
                  {entries.length > 0 ? (
                    <CommissionEntriesTable
                      entries={entries}
                      isAdmin={isAdmin}
                      onMarkPaid={handleMarkPaid}
                      onAmountUpdated={() => mutateEntries()}
                    />
                  ) : !entriesError ? (
                    <Skeleton className="h-64 w-full" />
                  ) : (
                    <Alert variant="destructive">
                      <AlertDescription>Failed to load entries</AlertDescription>
                    </Alert>
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </Layout>
    </AuthGuard>
    </ErrorBoundary>
  );
}

