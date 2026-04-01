'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle, AlertTriangle, Clock } from 'lucide-react';
import { format } from 'date-fns';

interface RevenueEventDetail {
  id: string;
  amountCollected: number;
  collectionDate: string;
  paymentStage: string;
  hasCommissionEntry: boolean;
  commissionAmount: number | null;
}

interface ServiceVerification {
  serviceId: string;
  serviceName: string;
  billingType: string;
  expectedCommission: number;
  accruedCommission: number;
  pendingCommission: number;
  expectedEntryCount: number;
  actualEntryCount: number;
  revenueEvents: RevenueEventDetail[];
  status: 'ok' | 'pending' | 'mismatch' | 'missing_entries' | 'wrong_count';
  message: string;
}

interface DealVerification {
  dealId: string;
  clientName: string;
  closeDate: string;
  expectedTotal: number;
  accruedTotal: number;
  pendingTotal: number;
  services: ServiceVerification[];
  status: 'ok' | 'pending' | 'mismatch' | 'missing_entries' | 'wrong_count';
  message: string;
  hasOverride?: boolean;
}

interface VerificationData {
  deals: DealVerification[];
  summary: {
    totalDeals: number;
    allVerified: boolean;
    withIssues: number;
  };
}

export function CommissionVerification() {
  const [data, setData] = useState<VerificationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/commission/verify', { credentials: 'include' })
      .then(res => res.json())
      .then(result => {
        if (result.error) throw new Error(result.error);
        setData(result);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!data) return null;

  const getStatusIcon = (status: string) => {
    if (status === 'ok') return <CheckCircle className="h-4 w-4 text-green-500" />;
    if (status === 'pending') return <Clock className="h-4 w-4 text-amber-500" />;
    return <AlertTriangle className="h-4 w-4 text-destructive" />;
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      ok: 'default',
      pending: 'secondary',
      mismatch: 'destructive',
      missing_entries: 'destructive',
      wrong_count: 'destructive',
    };
    return <Badge variant={variants[status] || 'outline'}>{status.replace(/_/g, ' ')}</Badge>;
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Commission Verification</CardTitle>
          <p className="text-sm text-muted-foreground">
            Verifies commission amounts and entry counts per service. Deposit: 2; One-off: 1; Paid on Completion: 1; MRR: 12; Quarterly: 4; Renewal: 1 (uplift, due 7 days after close).
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 mb-6">
            <div className="text-center p-4 rounded-lg bg-muted/50 min-w-[120px]">
              <div className="text-2xl font-bold">{data.summary.totalDeals}</div>
              <div className="text-xs text-muted-foreground">Deals checked</div>
            </div>
            <div className="text-center p-4 rounded-lg bg-muted/50 min-w-[120px]">
              <div className="text-2xl font-bold">{data.summary.withIssues}</div>
              <div className="text-xs text-muted-foreground">With issues</div>
            </div>
            <div className="text-center p-4 rounded-lg bg-muted/50 min-w-[120px]">
              <div className="text-2xl font-bold">{data.summary.allVerified ? '✓' : '✗'}</div>
              <div className="text-xs text-muted-foreground">All verified</div>
            </div>
          </div>

          <div className="space-y-4">
            {data.deals.map(deal => (
              <Card key={deal.dealId}>
                <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {getStatusIcon(deal.status)}
                      <div>
                        <CardTitle className="text-base">{deal.clientName}</CardTitle>
                        <p className="text-sm text-muted-foreground">
                          Closed {format(new Date(deal.closeDate), 'MMM d, yyyy')} · {deal.message}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {deal.hasOverride && (
                        <Badge variant="outline" className="font-normal text-amber-700 bg-amber-50 border-amber-200">
                          Override
                        </Badge>
                      )}
                      {getStatusBadge(deal.status)}
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground mt-2">
                    Expected ${deal.expectedTotal.toFixed(2)} | Accrued ${deal.accruedTotal.toFixed(2)}
                    {deal.pendingTotal > 0 && ` | Pending $${deal.pendingTotal.toFixed(2)} (future)`}
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-4">
                    {deal.services.map(svc => (
                      <div key={svc.serviceId} className="space-y-2 pl-4 border-l-2 border-muted">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{svc.serviceName}</span>
                          <span className="text-sm text-muted-foreground">
                            {svc.billingType} · {svc.actualEntryCount}/{svc.expectedEntryCount} entries | {svc.message}
                          </span>
                        </div>
                        <div className="text-sm space-y-1">
                          {svc.revenueEvents.map(re => (
                            <div key={re.id} className="flex items-center gap-4 text-muted-foreground flex-wrap">
                              <span>{format(new Date(re.collectionDate), 'MMM d, yyyy')}</span>
                              <span>${re.amountCollected.toLocaleString()} collected</span>
                              <Badge variant="outline" className="text-xs">{re.paymentStage}</Badge>
                              {re.hasCommissionEntry ? (
                                <Badge variant="default" className="text-xs">
                                  ${(re.commissionAmount ?? 0).toFixed(2)} commission ✓
                                </Badge>
                              ) : re.collectionDate <= new Date().toISOString().split('T')[0] ? (
                                <Badge variant="destructive" className="text-xs">Missing entry - run Reprocess</Badge>
                              ) : (
                                <Badge variant="secondary" className="text-xs">Future (after {re.collectionDate})</Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
