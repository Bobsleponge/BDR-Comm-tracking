'use client';

import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { DashboardStats } from '@/components/dashboard/DashboardStats';
import { RecentDealsTable } from '@/components/dashboard/RecentDealsTable';
import { TargetProgressChart } from '@/components/dashboard/TargetProgressChart';
import Link from 'next/link';
import { getQuarterFromDate } from '@/lib/commission/calculator';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';

interface DashboardStats {
  closedDeals: number;
  commissionEarned: number;
  commissionPending: number;
  quarterlyProgress: {
    revenueCollected: number;
    achievedPercent: number;
    bonusEligible: boolean;
    target: number;
  };
  annualProgress?: {
    revenueCollected: number;
    target: number;
    achievedPercent: number;
    daysElapsed: number;
    daysRemaining: number;
  };
  bhagProgress?: {
    revenueCollected: number;
    target: number;
    achievedPercent: number;
    daysElapsed: number;
    daysRemaining: number;
  };
  nextMonthPayout: number;
}

interface Deal {
  id: string;
  client_name: string;
  service_type: string;
  deal_value: number;
  status: 'proposed' | 'closed-won' | 'closed-lost';
  close_date: string | null;
  created_at: string;
}

const fetcher = async (url: string) => {
  try {
    const res = await fetch(url, { credentials: 'include' });
    const { safeJsonParse } = await import('@/lib/utils/client-helpers');
    const data = await safeJsonParse(res);
    // If the response has an error property, throw it so SWR treats it as an error
    if (!res.ok || data.error) {
      throw new Error(data.error || `Failed to fetch: ${res.statusText}`);
    }
    return data;
  } catch (error: any) {
    throw error;
  }
};

export default function DashboardPage() {
  // Use SWR for data fetching with automatic caching and revalidation
  const { data: stats, error: statsError } = useSWR<DashboardStats>('/api/dashboard/stats', fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false, // Don't auto-refetch on reconnect
    dedupingInterval: 60000, // Increased to 60 seconds
    onError: (error) => {
      console.error('Dashboard stats error:', error);
    },
  });

  const { data: dealsRaw, error: dealsError } = useSWR<any>('/api/deals?status=closed-won&limit=5', fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60000,
  });
  
  // Extract deals array from paginated response
  const deals: Deal[] = Array.isArray(dealsRaw) 
    ? dealsRaw 
    : (dealsRaw?.data || []);

  const loading = !stats && !statsError && !dealsRaw && !dealsError;
  const error = statsError || dealsError;

  if (loading) {
    return (
      <AuthGuard>
        <Layout>
          <div className="px-4 py-6 sm:px-0 space-y-6">
            <div className="flex justify-between items-center">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-10 w-24" />
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-32" />
              ))}
            </div>
          </div>
        </Layout>
      </AuthGuard>
    );
  }

  if (error) {
    return (
      <AuthGuard>
        <Layout>
          <div className="px-4 py-6 sm:px-0">
            <Alert variant="destructive">
              <AlertDescription>
                Error: {error.message || 'Failed to load dashboard'}
              </AlertDescription>
            </Alert>
          </div>
        </Layout>
      </AuthGuard>
    );
  }

  const currentQuarter = getQuarterFromDate(new Date());
  const displayDeals = deals?.slice(0, 5) || [];

  return (
    <ErrorBoundary>
      <AuthGuard>
        <Layout>
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6 flex justify-between items-center">
            <h2 className="text-2xl font-bold">Dashboard</h2>
            <Link href="/deals/new">
              <Button>New Deal</Button>
            </Link>
          </div>

          {stats && (
            <>
              <div className="mb-6">
                <DashboardStats
                  closedDeals={stats.closedDeals ?? 0}
                  commissionEarned={stats.commissionEarned ?? 0}
                  commissionPending={stats.commissionPending ?? 0}
                  nextMonthPayout={stats.nextMonthPayout ?? 0}
                />
              </div>

              {/* Target Progress Overview Chart - Circular Indicators Only */}
              {stats.quarterlyProgress && (
                <div className="mb-6">
                  <TargetProgressChart
                    quarterly={{
                      title: `Quarterly - ${currentQuarter}`,
                      revenueCollected: stats.quarterlyProgress.revenueCollected ?? 0,
                      target: stats.quarterlyProgress.target ?? 75000,
                      achievedPercent: stats.quarterlyProgress.achievedPercent ?? 0,
                    }}
                    annual={stats.annualProgress ? {
                      title: 'Annual Target ($250k)',
                      revenueCollected: stats.annualProgress.revenueCollected ?? 0,
                      target: stats.annualProgress.target ?? 250000,
                      achievedPercent: stats.annualProgress.achievedPercent ?? 0,
                    } : undefined}
                    bhag={stats.bhagProgress ? {
                      title: 'BHAG ($800k)',
                      revenueCollected: stats.bhagProgress.revenueCollected ?? 0,
                      target: stats.bhagProgress.target ?? 800000,
                      achievedPercent: stats.bhagProgress.achievedPercent ?? 0,
                    } : undefined}
                  />
                </div>
              )}

              <div className="mb-6">
                <RecentDealsTable deals={displayDeals} />
              </div>
            </>
          )}
        </div>
      </Layout>
    </AuthGuard>
    </ErrorBoundary>
  );
}



