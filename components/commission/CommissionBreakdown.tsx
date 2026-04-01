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
import { ChevronDown, ChevronRight, Download, FileSpreadsheet } from 'lucide-react';

interface CommissionBreakdownEntry {
  id: string;
  amount: number;
  status: string;
  isApproved?: boolean;
  accrualDate: string | null;
  payableDate: string | null;
  previousDealAmount?: number | null;
  newDealAmount?: number | null;
  deal: {
    id: string;
    clientName: string;
    serviceType: string;
    closeDate: string | null;
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
    billingType?: string;
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

  const formatMoney = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const monthApprovalAmounts = (entries: CommissionBreakdownEntry[]) => {
    const approvedAmount = entries
      .filter((e) => e.isApproved === true)
      .reduce((sum, e) => sum + e.amount, 0);
    const leftToClaim = entries
      .filter((e) => e.isApproved !== true)
      .reduce((sum, e) => sum + e.amount, 0);
    return { approvedAmount, leftToClaim };
  };

  const handleExportMonth = async (month: string) => {
    try {
      const exportUrl = `/api/commission/export?payable_month=${month}`;
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
      let filename = `commissions-${month}.xlsx`;
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

  const handleCommSheet = async (month: string) => {
    const cutoff = new Date().toISOString().split('T')[0]; // YYYY-MM-DD (today)
    try {
      const exportUrl = `/api/commission/export?payable_month=${month}&payable_cutoff=${cutoff}`;
      const res = await fetch(exportUrl, {
        credentials: 'include',
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to export comm sheet');
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const contentDisposition = res.headers.get('Content-Disposition');
      let filename = `comm-sheet-${month}-as-of-${cutoff}.xlsx`;
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="(.+)"/);
        if (filenameMatch) filename = filenameMatch[1];
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
                  <SelectItem value="all">All Billing Types</SelectItem>
                  <SelectItem value="one_off">One-Off</SelectItem>
                  <SelectItem value="monthly">Monthly (MRR)</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="deposit">50/50 Deposit</SelectItem>
                  <SelectItem value="paid_on_completion">Paid on Completion</SelectItem>
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
          const { approvedAmount, leftToClaim } = monthApprovalAmounts(monthData.entries);
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
                      <p className="text-sm mt-1.5 text-muted-foreground">
                        <span className="font-medium text-green-700 dark:text-green-400">
                          {formatMoney(approvedAmount)} approved
                        </span>
                        <span className="mx-1.5 text-muted-foreground/80">·</span>
                        <span>{formatMoney(leftToClaim)} left to claim</span>
                      </p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-sm text-muted-foreground">
                          {monthData.entries.length} {monthData.entries.length === 1 ? 'entry' : 'entries'}
                        </span>
                        {(() => {
                          const approved = monthData.entries.filter(e => e.isApproved).length;
                          const pending = monthData.entries.filter(e => e.isApproved === false).length;
                          if (approved > 0 || pending > 0) {
                            return (
                              <>
                                {approved > 0 && <Badge variant="default" className="bg-green-600/90 text-xs">{approved} approved</Badge>}
                                {pending > 0 && <Badge variant="secondary" className="text-xs">{pending} pending</Badge>}
                              </>
                            );
                          }
                          return null;
                        })()}
                        {monthData.entries.some(e => e.service?.billingType === 'quarterly' || e.service?.billingType === 'monthly') && (
                          <Badge variant="secondary">Recurring Services</Badge>
                        )}
                        {monthData.entries.some(e => e.revenueEvent?.paymentStage === 'scheduled') && (
                          <Badge variant="outline">Includes Scheduled</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-xl font-bold">
                        ${monthData.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <span className="text-xs text-muted-foreground">Claim this month</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCommSheet(monthData.month)}
                        className="flex items-center gap-2"
                        title={`Export commission sheet for ${formatMonth(monthData.month)} up to today (${new Date().toISOString().split('T')[0]})`}
                      >
                        <FileSpreadsheet className="h-4 w-4" />
                        Comm Sheet
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleExportMonth(monthData.month)}
                        className="flex items-center gap-2"
                      >
                        <Download className="h-4 w-4" />
                        Export
                      </Button>
                    </div>
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
                          <TableHead>Close Date</TableHead>
                          <TableHead>Payable Date</TableHead>
                          <TableHead>Revenue</TableHead>
                          <TableHead>Previous</TableHead>
                          <TableHead>New</TableHead>
                          <TableHead>Commission</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Approval</TableHead>
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
                                    {entry.revenueEvent?.billingType === 'renewal' && (
                                      <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                                        Renewal Uplift
                                      </Badge>
                                    )}
                                  </div>
                                </>
                              ) : entry.revenueEvent?.billingType === 'renewal' ? (
                                <div>
                                  <div className="font-medium">Renewal Uplift</div>
                                  <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 mt-1">
                                    Renewal
                                  </Badge>
                                </div>
                              ) : (
                                <span className="text-sm text-muted-foreground">N/A</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2 flex-wrap">
                                {entry.revenueEvent?.billingType === 'renewal' && (
                                  <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                                    Renewal
                                  </Badge>
                                )}
                                {getPaymentStageBadge(entry.revenueEvent?.paymentStage)}
                              </div>
                            </TableCell>
                            <TableCell>
                              {entry.deal?.closeDate
                                ? format(parseISO(entry.deal.closeDate), 'MMM dd, yyyy')
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
                            <TableCell>
                              {entry.previousDealAmount != null && entry.previousDealAmount > 0
                                ? `$${entry.previousDealAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                : '—'}
                            </TableCell>
                            <TableCell>
                              {entry.newDealAmount != null && entry.newDealAmount > 0
                                ? `$${entry.newDealAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                : '—'}
                            </TableCell>
                            <TableCell className="font-medium">
                              ${entry.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell>
                              <Badge variant={getStatusVariant(entry.status)}>
                                {entry.status}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {entry.isApproved !== undefined ? (
                                <Badge variant={entry.isApproved ? 'default' : 'secondary'} className={entry.isApproved ? 'bg-green-600 hover:bg-green-600' : ''}>
                                  {entry.isApproved ? 'Approved' : 'Pending'}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground text-sm">—</span>
                              )}
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

