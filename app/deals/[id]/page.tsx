'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { DealForm } from '@/components/deals/DealForm';
import { CommissionBreakdown } from '@/components/deals/CommissionBreakdown';
import Link from 'next/link';
import { format } from 'date-fns';
import { calculateDealTotalCommission } from '@/lib/commission/calculator';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';

export default function DealDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [deal, setDeal] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [baseCommissionRate, setBaseCommissionRate] = useState(0.025);

  useEffect(() => {
    const fetchDeal = async () => {
      try {
        const res = await fetch(`/api/deals/${params.id}`);
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({ error: 'Failed to fetch deal' }));
          throw new Error(errorData.error || 'Failed to fetch deal');
        }
        const data = await res.json();
        setDeal(data);
      } catch (err: any) {
        setError(err.message || 'Failed to fetch deal');
      } finally {
        setLoading(false);
      }
    };

    const fetchCommissionRules = async () => {
      try {
        const res = await fetch('/api/rules');
        if (res.ok) {
          const data = await res.json();
          if (data && data.base_rate) {
            setBaseCommissionRate(data.base_rate);
          }
        }
      } catch (err) {
        console.error('Failed to fetch commission rules:', err);
      }
    };

    fetchDeal();
    fetchCommissionRules();
  }, [params.id]);

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel this deal? This will cancel all future commission payments.')) {
      return;
    }

    setCancelling(true);
    try {
      const cancellationDate = new Date().toISOString().split('T')[0];
      const res = await fetch(`/api/deals/${params.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancellation_date: cancellationDate }),
      });

      if (!res.ok) throw new Error('Failed to cancel deal');
      router.refresh();
      window.location.reload();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <AuthGuard>
        <Layout>
          <div className="px-4 py-6 sm:px-0 space-y-6">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-64 w-full" />
          </div>
        </Layout>
      </AuthGuard>
    );
  }

  if (error || !deal) {
    return (
      <AuthGuard>
        <Layout>
          <div className="px-4 py-6 sm:px-0">
            <Alert variant="destructive">
              <AlertDescription>{error || 'Deal not found'}</AlertDescription>
            </Alert>
          </div>
        </Layout>
      </AuthGuard>
    );
  }

  if (editing) {
    return (
      <AuthGuard>
        <Layout>
          <div className="px-4 py-6 sm:px-0">
            <h2 className="text-2xl font-bold mb-6">Edit Deal</h2>
            <Card>
              <CardHeader>
                <CardTitle>Edit Deal Information</CardTitle>
              </CardHeader>
              <CardContent>
                <DealForm dealId={deal.id} initialData={deal} />
                <Button
                  variant="ghost"
                  onClick={() => setEditing(false)}
                  className="mt-4"
                >
                  Cancel editing
                </Button>
              </CardContent>
            </Card>
          </div>
        </Layout>
      </AuthGuard>
    );
  }

  const getStatusVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    if (status === 'closed-won') return 'default';
    if (status === 'closed-lost') return 'destructive';
    return 'secondary';
  };

  return (
    <AuthGuard>
      <Layout>
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6 flex justify-between items-center">
            <h2 className="text-2xl font-bold">Deal Details</h2>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              {deal.status === 'closed-won' && !deal.cancellation_date && (
                <Button
                  variant="destructive"
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? 'Cancelling...' : 'Cancel Deal'}
                </Button>
              )}
              <Link href="/deals">
                <Button variant="outline">Back to Deals</Button>
              </Link>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{deal.client_name}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Service Type</dt>
                  <dd className="mt-1 text-sm">{deal.service_type}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Deal Value</dt>
                  <dd className="mt-1 text-sm font-medium">
                    ${deal.deal_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Status</dt>
                  <dd className="mt-1">
                    <Badge variant={getStatusVariant(deal.status)}>
                      {deal.status.replace('-', ' ')}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Proposal Date</dt>
                  <dd className="mt-1 text-sm">
                    {format(new Date(deal.proposal_date), 'MMM d, yyyy')}
                  </dd>
                </div>
                {deal.close_date && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Close Date</dt>
                    <dd className="mt-1 text-sm">
                      {format(new Date(deal.close_date), 'MMM d, yyyy')}
                    </dd>
                  </div>
                )}
                {deal.first_invoice_date && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">First Invoice Date</dt>
                    <dd className="mt-1 text-sm">
                      {format(new Date(deal.first_invoice_date), 'MMM d, yyyy')}
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">Payout Months</dt>
                  <dd className="mt-1 text-sm">{deal.payout_months}</dd>
                </div>
                {deal.cancellation_date && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Cancellation Date</dt>
                    <dd className="mt-1 text-sm text-destructive font-medium">
                      {format(new Date(deal.cancellation_date), 'MMM d, yyyy')}
                    </dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          {/* Commission Breakdown */}
          {deal.deal_services && deal.deal_services.length > 0 && (
            <div className="mt-6">
              <CommissionBreakdown
                services={deal.deal_services}
                totalCommission={calculateDealTotalCommission(deal.deal_services)}
                baseCommissionRate={baseCommissionRate}
              />
            </div>
          )}
        </div>
      </Layout>
    </AuthGuard>
  );
}



