'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import Link from 'next/link';
import { format } from 'date-fns';
import { exportDealsToCSV } from '@/lib/utils/csv-export';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';

interface Deal {
  id: string;
  client_name: string;
  service_type: string;
  deal_value: number;
  status: 'proposed' | 'closed-won' | 'closed-lost';
  proposal_date: string;
  close_date: string | null;
  cancellation_date: string | null;
  bdr_reps?: {
    name: string;
    email: string;
  };
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
      const { safeJsonParse } = await import('@/lib/utils/client-helpers');
  const data = await safeJsonParse(res);
  if (!res.ok || data.error) {
    throw new Error(data.error || 'Failed to fetch');
  }
  return data;
};

export default function DealsPage() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isAdmin, setIsAdmin] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pathname = usePathname();

  // Use SWR for data fetching with automatic caching
  const url = statusFilter === 'all' ? '/api/deals' : `/api/deals?status=${statusFilter}`;
  const { data: dealsRaw, error, isLoading: loading, mutate } = useSWR<any>(url, fetcher, {
    revalidateOnFocus: true, // Refetch on window focus to get fresh data
    revalidateOnReconnect: true,
    dedupingInterval: 5000, // Reduce dedupe interval to 5 seconds
  });
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/deals/page.tsx:56',message:'dealsRaw value check',data:{type:typeof dealsRaw,isArray:Array.isArray(dealsRaw),hasData:!!dealsRaw?.data,hasPagination:!!dealsRaw?.pagination,keys:dealsRaw?Object.keys(dealsRaw):null},timestamp:Date.now(),runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  
  // Extract deals array from paginated response
  const deals: Deal[] = Array.isArray(dealsRaw) 
    ? dealsRaw 
    : (dealsRaw?.data || []);
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/deals/page.tsx:64',message:'deals after extraction',data:{type:typeof deals,isArray:Array.isArray(deals),length:deals?.length},timestamp:Date.now(),runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion

  // Fetch admin status once
  useSWR('/api/auth/user', fetcher, {
    onSuccess: (data) => {
      if (data?.role === 'admin') {
        setIsAdmin(true);
      }
    },
    revalidateOnFocus: false,
  });

  const handleDelete = async (dealId: string) => {
    if (!dealId) {
      alert('Invalid deal ID');
      return;
    }

    if (!confirm('Are you sure you want to delete this deal? This action cannot be undone.')) {
      return;
    }

    setDeleting(dealId);
    try {
      const res = await fetch(`/api/deals/${dealId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) {
        // Revert on error and refresh from server
        const errorData = await res.json();
        
        // If deal not found, it might have been deleted already - just refresh the list
        if (errorData.error?.includes('not found')) {
          await mutate(); // Refresh from server
          return; // Don't show error for already-deleted deals
        }
        
        // For other errors, show error
        throw new Error(errorData.error || 'Failed to delete deal');
      }

      // Delete succeeded - immediately update local cache to remove the deal
      mutate(deals.filter(d => d.id !== dealId), false);
      
      // Then force a fresh fetch from server to ensure consistency
      // Add a small delay to ensure the database has processed the delete
      setTimeout(async () => {
        await mutate();
      }, 100);
    } catch (err: any) {
      // Revert on error
      mutate();
      console.error('Delete error:', err);
      alert(err.message || 'Failed to delete deal');
    } finally {
      setDeleting(null);
    }
  };

  const getStatusVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    if (status === 'closed-won') return 'default';
    if (status === 'closed-lost') return 'destructive';
    return 'secondary';
  };

  // Separate deals into active and cancelled
  // Apply status filter to active deals, but always show all cancelled deals
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/f0f85447-8287-450d-8621-69d25602cd44',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app/deals/page.tsx:126',message:'Before filter - deals check',data:{type:typeof deals,isArray:Array.isArray(deals),hasFilter:typeof deals?.filter === 'function'},timestamp:Date.now(),runId:'run1',hypothesisId:'B'})}).catch(()=>{});
  // #endregion
  const allActiveDeals = deals.filter(deal => !deal.cancellation_date);
  const cancelledDeals = deals.filter(deal => deal.cancellation_date);
  
  // Apply status filter to active deals
  const activeDeals = statusFilter === 'all' 
    ? allActiveDeals 
    : allActiveDeals.filter(deal => deal.status === statusFilter);

  const renderDealsTable = (dealsToShow: Deal[], title: string, isCancelled: boolean = false) => {
    return (
      <Card className={`mb-8 ${isCancelled ? 'border-destructive' : ''}`}>
        <CardHeader>
          <CardTitle className={isCancelled ? 'text-destructive' : ''}>
            {title} {isCancelled && cancelledDeals.length > 0 && `(${cancelledDeals.length})`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dealsToShow.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              {isCancelled ? 'No cancelled deals' : 'No deals found'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Proposal Date</TableHead>
                    <TableHead>Close Date</TableHead>
                    {isCancelled && <TableHead>Cancelled Date</TableHead>}
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dealsToShow.map((deal) => (
                    <TableRow key={deal.id} className={isCancelled ? 'opacity-75' : ''}>
                      <TableCell className="font-medium">{deal.client_name}</TableCell>
                      <TableCell>{deal.service_type}</TableCell>
                      <TableCell>
                        ${deal.deal_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge variant={getStatusVariant(deal.status)}>
                            {deal.status.replace('-', ' ')}
                          </Badge>
                          {isCancelled && (
                            <Badge variant="destructive">Cancelled</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {format(new Date(deal.proposal_date), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell>
                        {deal.close_date ? format(new Date(deal.close_date), 'MMM d, yyyy') : '-'}
                      </TableCell>
                      {isCancelled && (
                        <TableCell className="text-destructive font-medium">
                          {deal.cancellation_date ? format(new Date(deal.cancellation_date), 'MMM d, yyyy') : '-'}
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Link href={`/deals/${deal.id}`}>
                            <Button variant="ghost" size="sm">View</Button>
                          </Link>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(deal.id)}
                            disabled={deleting === deal.id}
                            className="text-destructive hover:text-destructive"
                          >
                            {deleting === deal.id ? 'Deleting...' : 'Delete'}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  if (loading) {
    return (
      <AuthGuard>
        <Layout>
          <div className="px-4 py-6 sm:px-0 space-y-6">
            <div className="flex justify-between items-center">
              <Skeleton className="h-8 w-32" />
              <div className="flex gap-2">
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-10 w-24" />
              </div>
            </div>
            <Skeleton className="h-64 w-full" />
          </div>
        </Layout>
      </AuthGuard>
    );
  }

  return (
    <ErrorBoundary>
      <AuthGuard>
        <Layout>
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6 flex justify-between items-center">
            <h2 className="text-2xl font-bold">Deals</h2>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => exportDealsToCSV(deals)}>
                Export CSV
              </Button>
              <Link href="/deals/new">
                <Button>New Deal</Button>
              </Link>
            </div>
          </div>

          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error.message || 'Failed to load deals'}</AlertDescription>
            </Alert>
          )}

          <div className="mb-4">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="proposed">Proposed</SelectItem>
                <SelectItem value="closed-won">Closed-Won</SelectItem>
                <SelectItem value="closed-lost">Closed-Lost</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Active Deals Section */}
          {renderDealsTable(activeDeals, 'Active Deals', false)}

          {/* Cancelled Deals Section */}
          {renderDealsTable(cancelledDeals, 'Cancelled Deals', true)}
        </div>
      </Layout>
    </AuthGuard>
    </ErrorBoundary>
  );
}

