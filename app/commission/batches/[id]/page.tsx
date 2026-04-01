'use client';

import { Fragment, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';
import { ArrowLeft, Download, Check, Trash2, Undo2, PlusCircle } from 'lucide-react';

interface BatchItem {
  id: string;
  commission_entry_id: string;
  override_amount: number | null;
  override_payment_date: string | null;
  override_commission_rate: number | null;
  adjustment_note: string | null;
  amount: number;
  amount_collected: number;
  commissionable_value?: number | null;
  is_renewal: boolean;
  previous_deal_amount: number | null;
  new_deal_amount: number | null;
  client_name: string;
  service_type: string;
  service_name: string;
  commission_rate: number | null;
  billing_type: string;
  collection_date: string;
  payable_date: string | null;
  accrual_date: string | null;
  month: string;
}

interface Batch {
  id: string;
  bdr_id: string;
  bdr_name?: string;
  run_date: string;
  status: 'draft' | 'approved' | 'paid';
  created_at: string;
  items: BatchItem[];
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `Failed to fetch: ${res.statusText}`);
  }
  return data;
};

export default function CommissionBatchDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [editingOverride, setEditingOverride] = useState<Record<string, string>>({});
  const [editingNote, setEditingNote] = useState<Record<string, string>>({});
  const [editingPaymentDate, setEditingPaymentDate] = useState<Record<string, string>>({});
  const [editingCommissionRate, setEditingCommissionRate] = useState<Record<string, string>>({});
  const [renewalOverrideEntryId, setRenewalOverrideEntryId] = useState<string | null>(null);
  const [renewalPreviousAmount, setRenewalPreviousAmount] = useState<Record<string, string>>({});

  const id = params.id as string;

  useEffect(() => {
    const fetchBatch = async () => {
      try {
        const data = await fetcher(`/api/commission/batches/${id}`);
        setBatch(data);
        const overrideMap: Record<string, string> = {};
        const noteMap: Record<string, string> = {};
        const paymentDateMap: Record<string, string> = {};
        const commissionRateMap: Record<string, string> = {};
        (data.items || []).forEach((item: BatchItem) => {
          if (item.override_amount != null) {
            overrideMap[item.commission_entry_id] = String(item.override_amount);
          }
          if (item.adjustment_note) {
            noteMap[item.commission_entry_id] = item.adjustment_note;
          }
          if (item.override_payment_date) {
            paymentDateMap[item.commission_entry_id] = item.override_payment_date;
          }
          if (item.override_commission_rate != null) {
            commissionRateMap[item.commission_entry_id] = String((item.override_commission_rate * 100).toFixed(2));
          }
        });
        setEditingOverride(overrideMap);
        setEditingNote(noteMap);
        setEditingPaymentDate(paymentDateMap);
        setEditingCommissionRate(commissionRateMap);
      } catch (err: any) {
        setError(err.message || 'Failed to fetch batch');
      } finally {
        setLoading(false);
      }
    };

    if (id) fetchBatch();
  }, [id]);

  const handleApprove = async () => {
    if (!confirm('Approve and finalize this report? You will not be able to edit it afterward.')) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}/approve`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to approve');
      }
      router.refresh();
      const data = await fetcher(`/api/commission/batches/${id}`);
      setBatch(data);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleUnapprove = async () => {
    if (!confirm('Revert this report to draft? You will be able to edit it and approve again after fixing any issues.')) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}/unapprove`, {
        method: 'POST',
        credentials: 'include',
      });
      const { safeJsonParse } = await import('@/lib/utils/client-helpers');
      const data = await safeJsonParse(res);
      if (!res.ok || data?.error) {
        throw new Error(data?.error || 'Failed to revert to draft');
      }
      // Re-fetch batch with cache bypass to get updated status
      const fresh = await fetcher(`/api/commission/batches/${id}?t=${Date.now()}`);
      setBatch(fresh);
      router.refresh();
    } catch (err: any) {
      alert(err?.message || 'Failed to revert to draft');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDiscard = async () => {
    if (!confirm('Discard this draft? All entries will be removed from the batch and returned to the eligible pool.')) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to discard');
      }
      router.push('/commission');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddMissingEntries = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'add_missing_entries' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to add entries');
      }
      const data = await res.json();
      const added = data.added_count ?? 0;
      if (added > 0) {
        const fresh = await fetcher(`/api/commission/batches/${id}`);
        setBatch(fresh);
        router.refresh();
      }
      if (added === 0) alert('No additional eligible entries found.');
      else alert(`Added ${added} entr${added === 1 ? 'y' : 'ies'} to this report.`);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveEntry = async (entryId: string) => {
    if (!confirm('Remove this entry from the batch? It will reappear in your next report pull.')) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'remove_entry', commission_entry_id: entryId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to remove');
      }
      const data = await fetcher(`/api/commission/batches/${id}`);
      setBatch(data);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveOverride = async (entryId: string) => {
    const val = editingOverride[entryId];
    const num = val === '' ? null : parseFloat(val);
    if (val !== '' && isNaN(num!)) {
      alert('Please enter a valid number');
      return;
    }
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'adjust_amount', commission_entry_id: entryId, override_amount: num }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      const data = await fetcher(`/api/commission/batches/${id}`);
      setBatch(data);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSavePaymentDate = async (entryId: string) => {
    const val = editingPaymentDate[entryId]?.trim() || null;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'update_payment_date', commission_entry_id: entryId, override_payment_date: val }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save');
      }
      const freshBatch = await fetcher(`/api/commission/batches/${id}`);
      setBatch(freshBatch);
      setEditingPaymentDate((prev) => {
        const next = { ...prev };
        const savedItem = freshBatch.items?.find((i: BatchItem) => i.commission_entry_id === entryId);
        if (savedItem?.override_payment_date != null) {
          next[entryId] = savedItem.override_payment_date.split('T')[0];
        } else {
          delete next[entryId];
        }
        return next;
      });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveCommissionRate = async (entryId: string) => {
    const val = editingCommissionRate[entryId]?.trim();
    if (val === '') {
      // Clear override
      setActionLoading(true);
      try {
        const res = await fetch(`/api/commission/batches/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ action: 'update_commission_rate', commission_entry_id: entryId, override_commission_rate: null }),
        });
        if (!res.ok) throw new Error('Failed to clear');
        const data = await fetcher(`/api/commission/batches/${id}`);
        setBatch(data);
        setEditingCommissionRate((prev) => ({ ...prev, [entryId]: '' }));
      } catch (err: any) {
        alert(err.message);
      } finally {
        setActionLoading(false);
      }
      return;
    }
    const pct = parseFloat(val);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      alert('Please enter a valid percentage (0-100)');
      return;
    }
    const rate = pct / 100;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'update_commission_rate', commission_entry_id: entryId, override_commission_rate: rate }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      const data = await fetcher(`/api/commission/batches/${id}`);
      setBatch(data);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveNote = async (entryId: string) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'add_note', commission_entry_id: entryId, adjustment_note: editingNote[entryId] || null }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      const data = await fetcher(`/api/commission/batches/${id}`);
      setBatch(data);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleOverrideToRenewal = async (entryId: string) => {
    const prevStr = renewalPreviousAmount[entryId]?.trim();
    const prev = parseFloat(prevStr ?? '');
    if (!prevStr || isNaN(prev) || prev < 0) {
      alert('Please enter a valid previous deal amount');
      return;
    }
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'override_to_renewal', commission_entry_id: entryId, previous_deal_amount: prev }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to apply');
      }
      const data = await fetcher(`/api/commission/batches/${id}`);
      setBatch(data);
      setRenewalOverrideEntryId(null);
      setRenewalPreviousAmount((p) => {
        const next = { ...p };
        delete next[entryId];
        return next;
      });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDownload = (format: 'csv' | 'xlsx') => {
    window.open(`/api/commission/batches/${id}/export?format=${format}`, '_blank');
  };

  if (loading) {
    return (
      <ErrorBoundary>
        <AuthGuard>
          <Layout>
            <div className="px-4 py-6 sm:px-0">
              <Skeleton className="h-8 w-48 mb-4" />
              <Skeleton className="h-64 w-full" />
            </div>
          </Layout>
        </AuthGuard>
      </ErrorBoundary>
    );
  }

  if (error || !batch) {
    return (
      <ErrorBoundary>
        <AuthGuard>
          <Layout>
            <div className="px-4 py-6 sm:px-0">
              <Alert variant="destructive">
                <AlertDescription>{error || 'Batch not found'}</AlertDescription>
              </Alert>
              <Link href="/commission">
                <Button variant="outline" className="mt-4">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Commission
                </Button>
              </Link>
            </div>
          </Layout>
        </AuthGuard>
      </ErrorBoundary>
    );
  }

  const isDraft = batch.status === 'draft';

  const getFinalAmount = (item: BatchItem): number => {
    if (item.override_amount != null) return item.override_amount;
    if (item.override_commission_rate != null && (item.amount_collected ?? 0) > 0) {
      return item.amount_collected * item.override_commission_rate;
    }
    // When amount is null (e.g. percentage-of-net-sales placeholder), use amount_collected * rate if available
    if ((item.amount == null || item.amount === 0) && item.commission_rate != null && (item.amount_collected ?? 0) > 0) {
      return item.amount_collected * item.commission_rate;
    }
    return item.amount ?? 0;
  };

  // Group items by payable month (YYYY-MM) for section headings
  const getEffectiveDate = (item: BatchItem) =>
    item.override_payment_date ?? item.payable_date ?? item.accrual_date ?? item.collection_date ?? '';
  const getPayableMonth = (item: BatchItem) => {
    const d = getEffectiveDate(item);
    return d ? d.toString().substring(0, 7) : '';
  };
  const formatMonthHeading = (monthStr: string) => {
    if (!monthStr) return 'Unknown month';
    const [y, m] = monthStr.split('-');
    const date = new Date(parseInt(y), parseInt(m) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const itemsByMonth = (batch.items ?? []).reduce<Record<string, BatchItem[]>>((acc, item) => {
    const month = getPayableMonth(item);
    if (!acc[month]) acc[month] = [];
    acc[month].push(item);
    return acc;
  }, {});
  const sortedMonths = Object.keys(itemsByMonth).sort();

  // Compute month totals first, then grand total = sum of month totals (guarantees they match)
  const monthTotals = Object.fromEntries(
    sortedMonths.map((month) => {
      const monthItems = itemsByMonth[month];
      const total = monthItems.reduce((sum, i) => {
        const amt = getFinalAmount(i);
        return sum + (typeof amt === 'number' && !isNaN(amt) ? Number(amt.toFixed(2)) : 0);
      }, 0);
      return [month, total];
    })
  );
  const totalAmount = sortedMonths.reduce((sum, month) => sum + monthTotals[month], 0);

  return (
    <ErrorBoundary>
      <AuthGuard>
        <Layout>
          <div className="px-4 py-6 sm:px-0">
            <div className="mb-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Link href="/commission">
                  <Button variant="ghost" size="icon">
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                </Link>
                <div>
                  <h2 className="text-2xl font-bold">Commission Report</h2>
                  <p className="text-muted-foreground">
                    Run date: {batch.run_date ? format(new Date(batch.run_date), 'MMM d, yyyy') : '—'}
                    {batch.bdr_name && ` • ${batch.bdr_name}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={isDraft ? 'secondary' : 'default'}>
                  {batch.status}
                </Badge>
                {isDraft && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAddMissingEntries}
                      disabled={actionLoading}
                      title="Add any eligible entries (e.g. from December) that weren't in the original pull"
                    >
                      <PlusCircle className="mr-2 h-4 w-4" />
                      Add missing entries
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDownload('xlsx')}
                      disabled={actionLoading || (batch.items?.length ?? 0) === 0}
                      title="Export to Excel before approving"
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Export Excel
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDownload('csv')}
                      disabled={actionLoading || (batch.items?.length ?? 0) === 0}
                      title="Export to CSV before approving"
                    >
                      Export CSV
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDiscard}
                      disabled={actionLoading}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Discard
                    </Button>
                    <Button
                      onClick={handleApprove}
                      disabled={actionLoading || (batch.items?.length ?? 0) === 0}
                    >
                      <Check className="mr-2 h-4 w-4" />
                      Approve & Finalize
                    </Button>
                  </>
                )}
                {!isDraft && (
                  <>
                    <Button onClick={() => handleDownload('xlsx')} variant="default">
                      <Download className="mr-2 h-4 w-4" />
                      Download Excel
                    </Button>
                    <Button onClick={() => handleDownload('csv')} variant="outline">
                      Download CSV
                    </Button>
                    {batch.status === 'approved' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleUnapprove}
                        disabled={actionLoading}
                        title="Revert to draft to fix issues and re-approve"
                      >
                        <Undo2 className="mr-2 h-4 w-4" />
                        Revert to Draft
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Line Items</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Total: ${totalAmount.toFixed(2)} ({batch.items?.length ?? 0} entries)
                </p>
              </CardHeader>
              <CardContent>
                {batch.items?.length === 0 ? (
                  <p className="text-muted-foreground py-8">No entries in this batch.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Client</TableHead>
                        <TableHead>Deal</TableHead>
                        <TableHead>Payable date</TableHead>
                        <TableHead>Amount claimed on</TableHead>
                        <TableHead>Is renewal</TableHead>
                        <TableHead>Previous</TableHead>
                        <TableHead>New</TableHead>
                        <TableHead>Commission %</TableHead>
                        <TableHead>Original commission</TableHead>
                        <TableHead>Override amount</TableHead>
                        <TableHead>Final amount</TableHead>
                        <TableHead>Note</TableHead>
                        {isDraft && <TableHead className="w-[100px]">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedMonths.map((month) => {
                        const monthItems = itemsByMonth[month];
                        const monthTotal = monthTotals[month] ?? 0;
                        return (
                          <Fragment key={month}>
                            <TableRow className="bg-muted/50 hover:bg-muted/50">
                              <TableCell colSpan={isDraft ? 13 : 12} className="font-semibold py-3">
                                {formatMonthHeading(month)} — ${monthTotal.toFixed(2)}
                              </TableCell>
                            </TableRow>
                            {monthItems.map((item) => {
                              const finalAmt = getFinalAmount(item);
                              const displayRate = item.override_commission_rate ?? item.commission_rate;
                              const commissionPct = displayRate != null ? `${(Number(displayRate) * 100).toFixed(2)}%` : '—';
                              const displayDate = item.override_payment_date ?? item.payable_date ?? item.accrual_date ?? item.collection_date;
                              const dealLabel = item.service_name || item.service_type || 'Deal';

                              return (
                                <Fragment key={item.id}>
                                  <TableRow>
                            <TableCell>{item.client_name}</TableCell>
                            <TableCell>{dealLabel}</TableCell>
                            <TableCell>
                              {isDraft ? (
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="date"
                                    className="w-36"
                                    value={(editingPaymentDate[item.commission_entry_id] ?? (item.override_payment_date ?? item.payable_date ?? item.accrual_date ?? item.collection_date ?? '')).toString().split('T')[0]}
                                    onChange={(e) =>
                                      setEditingPaymentDate((prev) => ({ ...prev, [item.commission_entry_id]: e.target.value }))
                                    }
                                  />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleSavePaymentDate(item.commission_entry_id)}
                                    disabled={actionLoading}
                                  >
                                    Save
                                  </Button>
                                </div>
                              ) : (
                                displayDate || '—'
                              )}
                            </TableCell>
                            <TableCell>
                              {(item.amount_collected ?? 0) > 0 ? `$${Number(item.amount_collected).toFixed(2)}` : '—'}
                            </TableCell>
                            <TableCell>{item.is_renewal ? 'Yes' : 'No'}</TableCell>
                            <TableCell>
                              {item.previous_deal_amount != null && item.previous_deal_amount > 0
                                ? `$${item.previous_deal_amount.toFixed(2)}`
                                : '—'}
                            </TableCell>
                            <TableCell>
                              {item.new_deal_amount != null && item.new_deal_amount > 0
                                ? `$${item.new_deal_amount.toFixed(2)}`
                                : '—'}
                            </TableCell>
                            <TableCell>
                              {isDraft ? (
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    max="100"
                                    placeholder="e.g. 2.5"
                                    className="w-20"
                                    value={editingCommissionRate[item.commission_entry_id] ?? (item.override_commission_rate != null ? (item.override_commission_rate * 100).toFixed(2) : '')}
                                    onChange={(e) =>
                                      setEditingCommissionRate((prev) => ({ ...prev, [item.commission_entry_id]: e.target.value }))
                                    }
                                  />
                                  <span className="text-xs text-muted-foreground">%</span>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleSaveCommissionRate(item.commission_entry_id)}
                                    disabled={actionLoading}
                                  >
                                    Save
                                  </Button>
                                </div>
                              ) : (
                                commissionPct
                              )}
                            </TableCell>
                            <TableCell>${item.amount.toFixed(2)}</TableCell>
                            <TableCell>
                              {isDraft ? (
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number"
                                    step="0.01"
                                    placeholder="—"
                                    className="w-24"
                                    value={editingOverride[item.commission_entry_id] ?? (item.override_amount != null ? String(item.override_amount) : '')}
                                    onChange={(e) =>
                                      setEditingOverride((prev) => ({ ...prev, [item.commission_entry_id]: e.target.value }))
                                    }
                                  />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleSaveOverride(item.commission_entry_id)}
                                    disabled={actionLoading}
                                  >
                                    Save
                                  </Button>
                                </div>
                              ) : (
                                item.override_amount != null ? `$${item.override_amount.toFixed(2)}` : '—'
                              )}
                            </TableCell>
                            <TableCell>${finalAmt.toFixed(2)}</TableCell>
                            <TableCell>
                              {isDraft ? (
                                <div className="flex items-center gap-2">
                                  <Input
                                    placeholder="Adjustment note"
                                    className="max-w-[200px]"
                                    value={editingNote[item.commission_entry_id] ?? (item.adjustment_note ?? '')}
                                    onChange={(e) =>
                                      setEditingNote((prev) => ({ ...prev, [item.commission_entry_id]: e.target.value }))
                                    }
                                  />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleSaveNote(item.commission_entry_id)}
                                    disabled={actionLoading}
                                  >
                                    Save
                                  </Button>
                                </div>
                              ) : (
                                item.adjustment_note ?? '—'
                              )}
                            </TableCell>
                            {isDraft && (
                              <TableCell>
                                <div className="flex flex-col gap-1">
                                  {!item.is_renewal && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs"
                                      onClick={() => setRenewalOverrideEntryId(renewalOverrideEntryId === item.commission_entry_id ? null : item.commission_entry_id)}
                                      disabled={actionLoading}
                                    >
                                      {renewalOverrideEntryId === item.commission_entry_id ? 'Cancel' : 'Mark as renewal'}
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-destructive hover:text-destructive h-7"
                                    onClick={() => handleRemoveEntry(item.commission_entry_id)}
                                    disabled={actionLoading}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              </TableCell>
                            )}
                                  </TableRow>
                                  {isDraft && !item.is_renewal && renewalOverrideEntryId === item.commission_entry_id && (
                                    <TableRow className="bg-muted/20">
                                      <TableCell colSpan={isDraft ? 13 : 12} className="py-3">
                                <div className="flex flex-wrap items-end gap-4 max-w-2xl">
                                  <div>
                                    <label className="block text-xs font-medium text-muted-foreground mb-1">Previous deal amount</label>
                                    <Input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      placeholder="Enter previous contract value"
                                      className="w-36"
                                      value={renewalPreviousAmount[item.commission_entry_id] ?? ''}
                                      onChange={(e) =>
                                        setRenewalPreviousAmount((p) => ({ ...p, [item.commission_entry_id]: e.target.value }))
                                      }
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-xs font-medium text-muted-foreground mb-1">New deal amount</label>
                                    <div className="flex h-9 items-center px-3 rounded-md border bg-muted/50 text-sm">
                                      $
                                      {(item.commissionable_value ?? item.amount_collected ?? 0).toLocaleString('en-US', {
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2,
                                      })}
                                    </div>
                                  </div>
                                  <div>
                                    <label className="block text-xs font-medium text-muted-foreground mb-1">Uplift</label>
                                    <div className="flex h-9 items-center px-3 rounded-md border bg-muted/50 text-sm font-medium">
                                      $
                                      {Math.max(
                                        0,
                                        (item.commissionable_value ?? item.amount_collected ?? 0) -
                                          parseFloat(renewalPreviousAmount[item.commission_entry_id] || '0')
                                      ).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </div>
                                  </div>
                                  <div>
                                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                                      Commission ({((item.commission_rate ?? 0.025) * 100).toFixed(1)}%)
                                    </label>
                                    <div className="flex h-9 items-center px-3 rounded-md border bg-muted/50 text-sm font-medium">
                                      $
                                      {(
                                        Math.max(
                                          0,
                                          (item.commissionable_value ?? item.amount_collected ?? 0) -
                                            parseFloat(renewalPreviousAmount[item.commission_entry_id] || '0')
                                        ) * (item.commission_rate ?? 0.025)
                                      ).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </div>
                                  </div>
                                  <Button
                                    onClick={() => handleOverrideToRenewal(item.commission_entry_id)}
                                    disabled={actionLoading || !renewalPreviousAmount[item.commission_entry_id]?.trim()}
                                  >
                                    Apply renewal override
                                  </Button>
                                </div>
                                      </TableCell>
                                    </TableRow>
                                  )}
                                </Fragment>
                            );
                          })}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </Layout>
      </AuthGuard>
    </ErrorBoundary>
  );
}
