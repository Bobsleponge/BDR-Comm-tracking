'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { ClientForm } from '@/components/clients/ClientForm';
import Link from 'next/link';
import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function ClientDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [client, setClient] = useState<any>(null);
  const [deals, setDeals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    fetchClient();
    fetchDeals();
  }, [params.id]);

  const fetchClient = async () => {
    try {
      const res = await fetch(`/api/clients/${params.id}`);
      if (!res.ok) throw new Error('Failed to fetch client');
      const { safeJsonParse } = await import('@/lib/utils/client-helpers');
      const data = await safeJsonParse(res);
      if (data.error) throw new Error(data.error);
      setClient(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchDeals = async () => {
    try {
      const res = await fetch(`/api/clients/${params.id}/deals`);
      if (res.ok) {
        const { safeJsonParse } = await import('@/lib/utils/client-helpers');
        const data = await safeJsonParse(res);
        if (!data.error) {
          setDeals(data);
        }
      }
    } catch (err) {
      console.error('Failed to fetch deals:', err);
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

  if (error || !client) {
    return (
      <AuthGuard>
        <Layout>
          <div className="px-4 py-6 sm:px-0">
            <Alert variant="destructive">
              <AlertDescription>{error || 'Client not found'}</AlertDescription>
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
            <h2 className="text-2xl font-bold mb-6">Edit Client</h2>
            <Card>
              <CardHeader>
                <CardTitle>Edit Client Information</CardTitle>
              </CardHeader>
              <CardContent>
                <ClientForm clientId={client.id} initialData={client} />
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

  const totalDealValue = deals
    .filter(d => d.status === 'closed-won')
    .reduce((sum, deal) => {
      if (deal.deal_services && deal.deal_services.length > 0) {
        return sum + deal.deal_services.reduce((s: number, svc: any) => s + (svc.commissionable_value || 0), 0);
      }
      return sum + (deal.deal_value || 0);
    }, 0);

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
            <h2 className="text-2xl font-bold">Client Details</h2>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Link href="/clients">
                <Button variant="outline">Back to Clients</Button>
              </Link>
            </div>
          </div>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>{client.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {client.company && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Company</dt>
                    <dd className="mt-1 text-sm">{client.company}</dd>
                  </div>
                )}
                {client.email && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Email</dt>
                    <dd className="mt-1 text-sm">{client.email}</dd>
                  </div>
                )}
                {client.phone && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">Phone</dt>
                    <dd className="mt-1 text-sm">{client.phone}</dd>
                  </div>
                )}
                {client.address && (
                  <div className="sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">Address</dt>
                    <dd className="mt-1 text-sm whitespace-pre-line">{client.address}</dd>
                  </div>
                )}
                {client.notes && (
                  <div className="sm:col-span-2">
                    <dt className="text-sm font-medium text-muted-foreground">Notes</dt>
                    <dd className="mt-1 text-sm whitespace-pre-line">{client.notes}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>

          {/* Deals Section */}
          <Card>
            <CardHeader>
              <div className="flex justify-between items-center">
                <CardTitle>Deals ({deals.length})</CardTitle>
                <div className="text-sm text-muted-foreground">
                  Total Value: ${totalDealValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {deals.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Proposal Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Value</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deals.map((deal) => {
                        const dealValue = deal.deal_services && deal.deal_services.length > 0
                          ? deal.deal_services.reduce((s: number, svc: any) => s + (svc.commissionable_value || 0), 0)
                          : deal.deal_value;
                        
                        return (
                          <TableRow key={deal.id}>
                            <TableCell>
                              {format(new Date(deal.proposal_date), 'MMM d, yyyy')}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2 flex-wrap">
                                <Badge variant={getStatusVariant(deal.status)}>
                                  {deal.status.replace('-', ' ')}
                                </Badge>
                                {deal.has_override && (
                                  <Badge variant="outline" className="font-normal text-amber-700 bg-amber-50 border-amber-200">
                                    Override
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="font-medium">
                              ${dealValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell>
                              <Link href={`/deals/${deal.id}`}>
                                <Button variant="ghost" size="sm">View</Button>
                              </Link>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  No deals found for this client.
                  <Link href="/deals/new" className="ml-2 text-primary hover:underline">
                    Create a deal
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </Layout>
    </AuthGuard>
  );
}



