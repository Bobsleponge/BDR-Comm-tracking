'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { isOverdue } from '@/lib/utils/overdue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface CommissionEntry {
  id: string;
  month: string;
  amount: number;
  status: 'pending' | 'paid' | 'cancelled' | 'accrued' | 'payable';
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
}

export function CommissionEntriesTable({ 
  entries, 
  isAdmin = false,
  onMarkPaid 
}: CommissionEntriesTableProps) {
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);

  const handleMarkPaid = async (id: string) => {
    if (!onMarkPaid) return;
    setMarkingPaid(id);
    try {
      await onMarkPaid(id);
    } finally {
      setMarkingPaid(null);
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
                        ${entry.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusVariant(entry.status)}>
                          {entry.status}
                        </Badge>
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

