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
import { ArrowLeft, Download, Check, Trash2, Undo2, PlusCircle, EyeOff, Banknote, Upload } from 'lucide-react';
import { ImportBossUpdateDialog } from '@/components/commission/ImportBossUpdateDialog';

interface BatchItem {
  id: string;
  commission_entry_id: string;
  override_amount: number | null;
  override_payment_date: string | null;
  override_commission_rate: number | null;
  override_amount_collected?: number | null;
  adjustment_note: string | null;
  amount: number | null;
  amount_collected: number | null;
  commissionable_value?: number | null;
  is_renewal: boolean;
  previous_deal_amount: number | null;
  new_deal_amount: number | null;
  client_name: string;
  service_type: string;
  service_name: string;
  commission_rate: number | null;
  billing_type: string;
  payment_sequence?: string;
  collection_date: string;
  payable_date: string | null;
  accrual_date: string | null;
  month: string;
  /** Auto summary of overrides (draft + frozen at approve). */
  change_summary?: string | null;
  /** Last batch-item update before approve (SQLite/Supabase). */
  adjusted_at?: string | null;
  is_adjusted?: boolean;
}

interface Batch {
  id: string;
  bdr_id: string;
  bdr_name?: string;
  run_date: string;
  payable_cutoff?: string | null;
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
  const [editingAmountClaimed, setEditingAmountClaimed] = useState<Record<string, string>>({});
  const [renewalOverrideEntryId, setRenewalOverrideEntryId] = useState<string | null>(null);
  const [renewalPreviousAmount, setRenewalPreviousAmount] = useState<Record<string, string>>({});
  const [importDialogOpen, setImportDialogOpen] = useState(false);

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
        const amountClaimedMap: Record<string, string> = {};
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
          if (item.amount_collected != null && item.amount_collected > 0) {
            amountClaimedMap[item.commission_entry_id] = String(item.amount_collected);
          }
        });
        setEditingOverride(overrideMap);
        setEditingNote(noteMap);
        setEditingPaymentDate(paymentDateMap);
        setEditingCommissionRate(commissionRateMap);
        setEditingAmountClaimed(amountClaimedMap);
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

  const handleMarkPaid = async () => {
    if (!confirm('Mark this report as paid? Commission lines will show as paid in the system.')) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}/mark-paid`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to mark as paid');
      }
      const fresh = await fetcher(`/api/commission/batches/${id}?t=${Date.now()}`);
      setBatch(fresh);
      router.refresh();
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

  const handleIgnoreEntry = async (entryId: string) => {
    if (
      !confirm(
        'Ignore this commission entry permanently? It will be removed from this report and will never appear in future reports. Future commission payments for this deal will still be claimable.'
      )
    ) {
      return;
    }
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'ignore_entry', commission_entry_id: entryId }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to ignore entry');
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save');
      }
      if (data.removed) {
        alert(data.message || 'Entry moved to a future report — it will appear on your next pull.');
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

  const handleSaveAmountClaimed = async (entryId: string) => {
    const val = editingAmountClaimed[entryId]?.trim();
    const num = val === '' || val == null ? null : parseFloat(val);
    if (val !== '' && val != null && (isNaN(num!) || num! < 0)) {
      alert('Please enter a valid non-negative amount');
      return;
    }
    setActionLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'update_amount_claimed',
          commission_entry_id: entryId,
          override_amount_collected: num,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      const data = await fetcher(`/api/commission/batches/${id}`);
      setBatch(data);
      const amountClaimedMap: Record<string, string> = {};
      (data.items || []).forEach((item: BatchItem) => {
        if (item.amount_collected != null && item.amount_collected > 0) {
          amountClaimedMap[item.commission_entry_id] = String(item.amount_collected);
        }
      });
      setEditingAmountClaimed(amountClaimedMap);
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

  const refreshBatch = async () => {
    const data = await fetcher(`/api/commission/batches/${id}?t=${Date.now()}`);
    setBatch(data);
    router.refresh();
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
  const isApproved = batch.status === 'approved';
  const isPaid = batch.status === 'paid';

  const formatMoney = (value: number | null | undefined): string =>
    value != null && !Number.isNaN(value) ? `$${Number(value).toFixed(2)}` : '—';

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
                    Payable through:{' '}
                    {(batch.payable_cutoff || batch.run_date)
                      ? (() => {
                          const raw = (batch.payable_cutoff || batch.run_date).slice(0, 10);
                          const [y, m, d] = raw.split('-');
                          return format(new Date(parseInt(y), parseInt(m) - 1, parseInt(d || '1')), 'MMM d, yyyy');
                        })()
                      : '—'}
                    {batch.bdr_name && ` • ${batch.bdr_name}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={isDraft ? 'secondary' : isPaid ? 'default' : 'outline'}>
                  {isPaid ? 'paid' : batch.status}
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
                      onClick={() => setImportDialogOpen(true)}
                      disabled={actionLoading || (batch.items?.length ?? 0) === 0}
                      title="Import annotated report returned by your boss"
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Import Boss Update
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setImportDialogOpen(true)}
                      disabled={actionLoading || (batch.items?.length ?? 0) === 0}
                      title="Preview boss feedback (revert to draft to apply)"
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Import Boss Update
                    </Button>
                    <Button onClick={() => handleDownload('xlsx')} variant="default">
                      <Download className="mr-2 h-4 w-4" />
                      Download Excel
                    </Button>
                    <Button onClick={() => handleDownload('csv')} variant="outline">
                      Download CSV
                    </Button>
                    {isApproved && (
                      <>
                        <Button
                          onClick={handleMarkPaid}
                          disabled={actionLoading}
                          title="Record that payment was sent for this report"
                        >
                          <Banknote className="mr-2 h-4 w-4" />
                          Mark as Paid
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleUnapprove}
                          disabled={actionLoading}
                          title="Revert to draft to adjust line items, then approve again"
                        >
                          <Undo2 className="mr-2 h-4 w-4" />
                          Revert to Draft
                        </Button>
                      </>
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
                        <TableHead>Payment</TableHead>
                        <TableHead>Payable date</TableHead>
                        <TableHead>Amount claimed on</TableHead>
                        <TableHead>Is renewal</TableHead>
                        <TableHead>Previous</TableHead>
                        <TableHead>New</TableHead>
                        <TableHead>Commission %</TableHead>
                        <TableHead>Original commission</TableHead>
                        <TableHead>Override amount</TableHead>
                        <TableHead>Final amount</TableHead>
                        <TableHead className="min-w-[200px]">Adjustment</TableHead>
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
                              <TableCell colSpan={isDraft ? 15 : 14} className="font-semibold py-3">
                                {formatMonthHeading(month)} — ${monthTotal.toFixed(2)}
                              </TableCell>
                            </TableRow>
                            {monthItems.map((item) => {
                              const finalAmt = getFinalAmount(item);
                              const displayRate = item.override_commission_rate ?? item.commission_rate;
                              const commissionPct = displayRate != null ? `${(Number(displayRate) * 100).toFixed(2)}%` : '—';
                              const displayDate = item.override_payment_date ?? item.payable_date ?? item.accrual_date ?? item.collection_date;
                              const dealLabel = item.service_name || item.service_type || 'Deal';

                              const rowHighlight =
                                item.is_adjusted === true ? 'bg-amber-500/10 hover:bg-amber-500/[0.14]' : '';
                              let adjustedDisplay = '';
                              try {
                                if (item.adjusted_at) adjustedDisplay = format(new Date(item.adjusted_at), 'MMM d, yyyy h:mm a');
                              } catch {
                                adjustedDisplay = String(item.adjusted_at ?? '');
                              }

                              return (
                                <Fragment key={item.id}>
                                  <TableRow className={rowHighlight}>
                            <TableCell>{item.client_name}</TableCell>
                            <TableCell>{dealLabel}</TableCell>
                            <TableCell className="whitespace-nowrap text-sm font-medium">
                              {item.payment_sequence || '1 of 1'}
                            </TableCell>
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
                              {isDraft ? (
                                <div className="flex items-center gap-2">
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    placeholder="Enter amount"
                                    className="w-28"
                                    value={
                                      editingAmountClaimed[item.commission_entry_id] ??
                                      (item.amount_collected != null && item.amount_collected > 0
                                        ? String(item.amount_collected)
                                        : '')
                                    }
                                    onChange={(e) =>
                                      setEditingAmountClaimed((prev) => ({
                                        ...prev,
                                        [item.commission_entry_id]: e.target.value,
                                      }))
                                    }
                                  />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleSaveAmountClaimed(item.commission_entry_id)}
                                    disabled={actionLoading}
                                  >
                                    Save
                                  </Button>
                                </div>
                              ) : (item.amount_collected ?? 0) > 0 ? (
                                formatMoney(item.amount_collected)
                              ) : (
                                '—'
                              )}
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
                            <TableCell>{formatMoney(item.amount)}</TableCell>
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
                            <TableCell>{formatMoney(finalAmt)}</TableCell>
                            <TableCell className="align-top">
                              {!item.change_summary && !item.is_adjusted && !adjustedDisplay ? (
                                '—'
                              ) : (
                                <div className="space-y-1 max-w-xs">
                                  {item.is_adjusted && (
                                    <Badge variant="outline" className="border-amber-600/50 text-amber-950 dark:text-amber-100">
                                      Adjusted
                                    </Badge>
                                  )}
                                  {item.change_summary ? (
                                    <p className="text-sm">{item.change_summary}</p>
                                  ) : null}
                                  {adjustedDisplay ? (
                                    <p className="text-xs text-muted-foreground">Recorded {adjustedDisplay}</p>
                                  ) : null}
                                </div>
                              )}
                            </TableCell>
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
                                    className="h-7 text-muted-foreground"
                                    onClick={() => handleIgnoreEntry(item.commission_entry_id)}
                                    disabled={actionLoading}
                                    title="Permanently waive this payment — future payments for this deal remain claimable"
                                  >
                                    <EyeOff className="mr-1 h-3.5 w-3.5" />
                                    Ignore
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-destructive hover:text-destructive h-7"
                                    onClick={() => handleRemoveEntry(item.commission_entry_id)}
                                    disabled={actionLoading}
                                    title="Remove from this report only — will appear in your next pull"
                                  >
                                    Remove
                                  </Button>
                                </div>
                              </TableCell>
                            )}
                                  </TableRow>
                                  {isDraft && !item.is_renewal && renewalOverrideEntryId === item.commission_entry_id && (
                                    <TableRow className="bg-muted/20">
                                      <TableCell colSpan={isDraft ? 14 : 13} className="py-3">
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

            <ImportBossUpdateDialog
              batchId={id}
              batchStatus={batch.status}
              open={importDialogOpen}
              onOpenChange={setImportDialogOpen}
              onApplied={refreshBatch}
              onRevertToDraft={handleUnapprove}
            />
          </div>
        </Layout>
      </AuthGuard>
    </ErrorBoundary>
  );
}
