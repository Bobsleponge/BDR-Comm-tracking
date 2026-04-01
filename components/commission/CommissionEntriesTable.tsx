'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { isOverdue } from '@/lib/utils/overdue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface CommissionEntry {
  id: string;
  month: string;
  amount: number | null;
  status: 'pending' | 'paid' | 'cancelled' | 'accrued' | 'payable';
  is_approved?: boolean;
  accrual_date?: string | null;
  payable_date?: string | null;
  deals?: {
    client_name: string;
    service_type: string;
  };
  revenue_events?: {
    service_id: string | null;
    service_name?: string | null;
    billing_type: string;
    amount_collected: number;
    collection_date: string;
    payment_stage?: string | null;
  } | null;
}

interface CommissionEntriesTableProps {
  entries: CommissionEntry[];
  isAdmin?: boolean;
  onMarkPaid?: (id: string) => Promise<void>;
  onAmountUpdated?: () => void | Promise<void>;
}

export function CommissionEntriesTable({ 
  entries, 
  isAdmin = false,
  onMarkPaid,
  onAmountUpdated
}: CommissionEntriesTableProps) {
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<CommissionEntry | null>(null);
  const [editAmount, setEditAmount] = useState<string>('');
  const [editNetSales, setEditNetSales] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const handleMarkPaid = async (id: string) => {
    if (!onMarkPaid) return;
    setMarkingPaid(id);
    try {
      await onMarkPaid(id);
    } finally {
      setMarkingPaid(null);
    }
  };

  const handleSaveAmount = async () => {
    if (!editingEntry) return;
    const amount = parseFloat(editAmount);
    const netSales = parseFloat(editNetSales);
    if (isNaN(amount) && isNaN(netSales)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/commission/entries/${editingEntry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          !isNaN(amount) ? { amount } : { net_sales: netSales }
        ),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.message || 'Failed to update');
        return;
      }
      setEditingEntry(null);
      setEditAmount('');
      setEditNetSales('');
      await onAmountUpdated?.();
    } finally {
      setSaving(false);
    }
  };

  const getStatusVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    if (status === 'paid') return 'default';
    if (status === 'cancelled') return 'destructive';
    if (status === 'payable') return 'default';
    return 'secondary';
  };

  const getPaymentStageBadge = (paymentStage: string | null | undefined) => {
    if (!paymentStage) return null;
    
    const isImmediate = paymentStage === 'invoice' || paymentStage === 'completion';
    const isScheduled = paymentStage === 'scheduled';
    
    if (isImmediate) {
      return <Badge variant="default" className="bg-green-500">Immediate</Badge>;
    }
    if (isScheduled) {
      return <Badge variant="secondary">Scheduled</Badge>;
    }
    return null;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Commission Entries</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client / Service</TableHead>
                <TableHead>Payment Type</TableHead>
                <TableHead>Collection Date</TableHead>
                <TableHead>Payable Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                {isAdmin && <TableHead>Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 7 : 6} className="text-center text-muted-foreground">
                    No commission entries found
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry) => {
                  const revenueEvent = entry.revenue_events;
                  const billingType = revenueEvent?.billing_type || entry.deals?.service_type || 'N/A';
                  const serviceName = revenueEvent?.service_name || billingType;
                  
                  return (
                    <TableRow key={entry.id} className={isOverdue(entry) ? 'bg-destructive/10' : ''}>
                      <TableCell>
                        <div className="font-medium">
                          {entry.deals?.client_name || 'N/A'}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {serviceName} {revenueEvent && `($${revenueEvent.amount_collected.toLocaleString()})`}
                          {!revenueEvent && entry.amount == null && (
                            <span className="ml-1 text-amber-600">• % of Net Sales (TBD)</span>
                          )}
                          {revenueEvent?.billing_type === 'renewal' && (
                            <span className="ml-1 text-purple-600">• Renewal Uplift</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 flex-wrap">
                          {revenueEvent?.billing_type === 'renewal' && (
                            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                              Renewal
                            </Badge>
                          )}
                          {getPaymentStageBadge(revenueEvent?.payment_stage)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {entry.accrual_date 
                          ? format(new Date(entry.accrual_date), 'MMM dd, yyyy')
                          : entry.month 
                            ? format(new Date(entry.month), 'MMM yyyy')
                            : 'N/A'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {entry.payable_date 
                            ? format(new Date(entry.payable_date), 'MMM dd, yyyy')
                            : 'N/A'}
                          {isOverdue(entry) && (
                            <Badge variant="destructive" className="text-xs">Overdue</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">
                        {entry.amount != null ? (
                          `$${entry.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        ) : (
                          <Dialog open={!!editingEntry && editingEntry.id === entry.id} onOpenChange={(open) => {
                            if (!open) setEditingEntry(null);
                            else {
                              setEditingEntry(entry);
                              setEditAmount('');
                              setEditNetSales('');
                            }
                          }}>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-amber-600 border-amber-200"
                              onClick={() => { setEditingEntry(entry); setEditAmount(''); setEditNetSales(''); }}
                            >
                              TBD — Enter amount
                            </Button>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>Enter commission amount</DialogTitle>
                                <DialogDescription>
                                  Enter the amount directly or enter net sales to calculate from billing %
                                </DialogDescription>
                              </DialogHeader>
                              <div className="grid gap-4 py-4">
                                <div className="grid gap-2">
                                  <label className="text-sm font-medium">Amount ($)</label>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    placeholder="e.g. 150.00"
                                    value={editAmount}
                                    onChange={(e) => setEditAmount(e.target.value)}
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <label className="text-sm font-medium">Or Net Sales ($)</label>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    placeholder="e.g. 10000"
                                    value={editNetSales}
                                    onChange={(e) => setEditNetSales(e.target.value)}
                                  />
                                </div>
                              </div>
                              <DialogFooter>
                                <Button variant="outline" onClick={() => setEditingEntry(null)}>Cancel</Button>
                                <Button onClick={handleSaveAmount} disabled={saving || (isNaN(parseFloat(editAmount)) && isNaN(parseFloat(editNetSales)))}>
                                  {saving ? 'Saving...' : 'Save'}
                                </Button>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={getStatusVariant(entry.status)}>
                            {entry.status}
                          </Badge>
                          {entry.is_approved !== undefined && (
                            <Badge variant={entry.is_approved ? 'default' : 'secondary'} className={entry.is_approved ? 'bg-green-600 hover:bg-green-600' : ''}>
                              {entry.is_approved ? 'Approved' : 'Pending'}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      {isAdmin && (
                        <TableCell>
                          {(entry.status === 'payable' || entry.status === 'accrued') && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleMarkPaid(entry.id)}
                              disabled={markingPaid === entry.id}
                            >
                              {markingPaid === entry.id ? 'Marking...' : 'Mark as Paid'}
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

