'use client';

import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface CommissionBreakdownEntry {
  id: string;
  amount: number;
  status: string;
  accrualDate: string | null;
  payableDate: string | null;
  deal: {
    id: string;
    clientName: string;
    serviceType: string;
  };
  service: {
    id: string;
    name: string;
    billingType: string;
  } | null;
  revenueEvent: {
    amountCollected: number;
    collectionDate: string;
    paymentStage: string;
  } | null;
}

interface MonthBreakdown {
  month: string;
  totalAmount: number;
  entries: CommissionBreakdownEntry[];
}

interface CommissionBreakdownProps {
  breakdown: MonthBreakdown[];
  total: number;
  onFilterChange?: (filters: { serviceType?: string; billingType?: string }) => void;
}

export function CommissionBreakdown({ breakdown, total, onFilterChange }: CommissionBreakdownProps) {
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  const [serviceTypeFilter, setServiceTypeFilter] = useState<string>('');
  const [billingTypeFilter, setBillingTypeFilter] = useState<string>('all');

  const toggleMonth = (month: string) => {
    const newExpanded = new Set(expandedMonths);
    if (newExpanded.has(month)) {
      newExpanded.delete(month);
    } else {
      newExpanded.add(month);
    }
    setExpandedMonths(newExpanded);
  };

  const handleFilterChange = () => {
    if (onFilterChange) {
      onFilterChange({
        serviceType: serviceTypeFilter || undefined,
        billingType: billingTypeFilter || undefined,
      });
    }
  };

  const getStatusVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    if (status === 'paid' || status === 'payable') return 'default';
    if (status === 'cancelled') return 'destructive';
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

  const formatMonth = (monthStr: string) => {
    const [year, month] = monthStr.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1, 1);
    return format(date, 'MMMM yyyy');
  };

  if (breakdown.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-center">No commission entries found</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="service-type-filter">Service Type</Label>
              <Input
                id="service-type-filter"
                type="text"
                value={serviceTypeFilter}
                onChange={(e) => setServiceTypeFilter(e.target.value)}
                onBlur={handleFilterChange}
                placeholder="Filter by service type"
              />
            </div>
            <div>
              <Label htmlFor="billing-type-filter">Billing Type</Label>
              <Select
                value={billingTypeFilter}
                onValueChange={(value) => {
                  setBillingTypeFilter(value);
                  if (onFilterChange) {
                    onFilterChange({
                      serviceType: serviceTypeFilter || undefined,
                      billingType: value && value !== 'all' ? value : undefined,
                    });
                  }
                }}
              >
                <SelectTrigger id="billing-type-filter">
                  <SelectValue placeholder="All Billing Types" />
                </SelectTrigger>
                <SelectContent>
                  {/* #region agent log */}
                  {(() => {
                    fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'components/commission/CommissionBreakdown.tsx:145',message:'Rendering SelectItem for billing type filter',data:{billingTypeFilter},timestamp:Date.now(),sessionId:'debug-session',runId:'initial',hypothesisId:'B'})}).catch(()=>{});
                    return null;
                  })()}
                  {/* #endregion */}
                  <SelectItem value="all">All Billing Types</SelectItem>
                  <SelectItem value="one_off">One-Off</SelectItem>
                  <SelectItem value="monthly">Monthly (MRR)</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="deposit">50/50 Deposit</SelectItem>
                  <SelectItem value="renewal">Renewal</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button onClick={handleFilterChange} className="w-full">
                Apply Filters
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-medium">Total Commission Due</h3>
            <span className="text-2xl font-bold">
              ${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Monthly Breakdown */}
      <div className="space-y-3">
        {breakdown.map((monthData) => {
          const isExpanded = expandedMonths.has(monthData.month);
          return (
            <Card key={monthData.month}>
              <CardHeader>
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-4">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleMonth(monthData.month)}
                    >
                      {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </Button>
                    <div>
                      <CardTitle>{formatMonth(monthData.month)}</CardTitle>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-sm text-muted-foreground">
                          {monthData.entries.length} {monthData.entries.length === 1 ? 'entry' : 'entries'}
                        </span>
                        {monthData.entries.some(e => e.service?.billingType === 'quarterly' || e.service?.billingType === 'monthly') && (
                          <Badge variant="secondary">Recurring Services</Badge>
                        )}
                        {monthData.entries.some(e => e.revenueEvent?.paymentStage === 'scheduled') && (
                          <Badge variant="outline">Includes Scheduled</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold">
                      ${monthData.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <span className="text-xs text-muted-foreground">Claim this month</span>
                  </div>
                </div>
              </CardHeader>
              {isExpanded && (
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Client / Deal</TableHead>
                          <TableHead>Service</TableHead>
                          <TableHead>Payment Type</TableHead>
                          <TableHead>Collection Date</TableHead>
                          <TableHead>Payable Date</TableHead>
                          <TableHead>Revenue</TableHead>
                          <TableHead>Commission</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {monthData.entries.map((entry) => (
                          <TableRow key={entry.id}>
                            <TableCell>
                              <div className="font-medium">{entry.deal.clientName}</div>
                              <div className="text-xs text-muted-foreground">{entry.deal.serviceType}</div>
                            </TableCell>
                            <TableCell>
                              {entry.service ? (
                                <>
                                  <div className="font-medium">{entry.service.name}</div>
                                  <div className="flex items-center gap-2 mt-1">
                                    <span className="text-xs text-muted-foreground">{entry.service.billingType}</span>
                                    {(entry.service.billingType === 'quarterly' || entry.service.billingType === 'monthly') && (
                                      <Badge variant="outline">Recurring</Badge>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <span className="text-sm text-muted-foreground">N/A</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {getPaymentStageBadge(entry.revenueEvent?.paymentStage)}
                            </TableCell>
                            <TableCell>
                              {entry.revenueEvent?.collectionDate
                                ? format(parseISO(entry.revenueEvent.collectionDate), 'MMM dd, yyyy')
                                : entry.accrualDate
                                  ? format(parseISO(entry.accrualDate), 'MMM dd, yyyy')
                                  : 'N/A'}
                            </TableCell>
                            <TableCell>
                              {entry.payableDate
                                ? format(parseISO(entry.payableDate), 'MMM dd, yyyy')
                                : 'N/A'}
                            </TableCell>
                            <TableCell>
                              {entry.revenueEvent
                                ? `$${entry.revenueEvent.amountCollected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                : 'N/A'}
                            </TableCell>
                            <TableCell className="font-medium">
                              ${entry.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell>
                              <Badge variant={getStatusVariant(entry.status)}>
                                {entry.status}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

