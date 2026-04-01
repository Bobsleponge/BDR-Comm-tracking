'use client';

import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { DashboardHeroKPIs } from '@/components/dashboard/DashboardHeroKPIs';
import { DashboardStatsGrid } from '@/components/dashboard/DashboardStatsGrid';
import { ProjectedCommissionByQuarter } from '@/components/dashboard/ProjectedCommissionByQuarter';
import { RecentDealsTable } from '@/components/dashboard/RecentDealsTable';
import { TargetProgressChart } from '@/components/dashboard/TargetProgressChart';
import { RevenueTrendChart } from '@/components/dashboard/RevenueTrendChart';
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
    newBusinessCollected?: number;
    renewalUpliftCollected?: number;
    achievedPercent: number;
    bonusEligible: boolean;
    target: number;
  };
  annualProgress?: {
    revenueCollected: number;
    newBusinessCollected?: number;
    renewalUpliftCollected?: number;
    target: number;
    achievedPercent: number;
    daysElapsed: number;
    daysRemaining: number;
  };
  bhagProgress?: {
    revenueCollected: number;
    newBusinessCollected?: number;
    renewalUpliftCollected?: number;
    target: number;
    achievedPercent: number;
    daysElapsed: number;
    daysRemaining: number;
  };
  nextMonthPayout?: number;
  quarterlyCommissionOnClosedDeals?: number;
  quarterlyCommissionBaseAmount?: number;
  projectedCommissionByQuarter?: Record<string, number>;
  quarterlyProgressByQuarter?: Record<string, { revenue: number; commission: number; bonus: number; target: number; achievedPercent: number }>;
  commissionAccruedThisMonth?: number;
  expectedBonusOnSignedDeals?: number;
  expectedBonusOnCashCollected?: number;
  projectedQuarterlyBonus?: number;
  ytdPayableRevenue?: number;
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
    revalidateOnFocus: true, // Refetch when tab regains focus (gets fresh bonus data)
    revalidateOnReconnect: true,
    dedupingInterval: 2000, // Allow refetch every 2s so numbers update when deals change
    onError: (error) => {
      console.error('Dashboard stats error:', error);
    },
  });

  const { data: dealsRaw, error: dealsError } = useSWR<any>('/api/deals?status=closed-won&limit=5', fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60000,
  });

  const { data: trendData } = useSWR<Array<{ month: string; amount: number }>>('/api/dashboard/trend', fetcher, {
    revalidateOnFocus: false,
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
              {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
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
            <div className="flex gap-2">
              <Link href="/commission/preview">
                <Button variant="outline">Commission Preview</Button>
              </Link>
              <Link href="/deals/new">
                <Button>New Deal</Button>
              </Link>
            </div>
          </div>

          {stats && (
            <>
              {/* 1. Hero KPI Row */}
              <div className="mb-6">
                <DashboardHeroKPIs
                  quarterlyCashCollected={stats.quarterlyProgress?.revenueCollected ?? 0}
                  quarterlyCommissionOnClosedDeals={stats.quarterlyCommissionOnClosedDeals ?? 0}
                  quarterlyCommissionBaseAmount={stats.quarterlyCommissionBaseAmount ?? 0}
                  projectedQuarterlyBonus={
                    stats.projectedQuarterlyBonus ??
                    stats.quarterlyProgressByQuarter?.[currentQuarter]?.bonus ??
                    0
                  }
                  expectedBonusOnCollectedCashToDate={
                    stats.expectedBonusOnCashCollected ??
                    stats.quarterlyProgressByQuarter?.[currentQuarter]?.bonus ??
                    stats.projectedQuarterlyBonus ??
                    0
                  }
                  ytdPayableRevenue={stats.ytdPayableRevenue ?? stats.annualProgress?.revenueCollected ?? 0}
                  currentQuarter={currentQuarter}
                />
              </div>

              {/* 2. Quarterly Goal Progress (Cash Collected) */}
              <div className="mb-6">
                <ProjectedCommissionByQuarter
                  quarterlyProgressByQuarter={stats.quarterlyProgressByQuarter}
                  projectedCommissionByQuarter={stats.projectedCommissionByQuarter}
                  currentQuarter={currentQuarter}
                />
              </div>

              {/* 3. Target Progress Overview */}
              {stats.quarterlyProgress && (
                <div className="mb-6">
                  <TargetProgressChart
                    quarterly={{
                      title: `Quarterly - ${currentQuarter}`,
                      revenueCollected: stats.quarterlyProgress.revenueCollected ?? 0,
                      target: stats.quarterlyProgress.target ?? 75000,
                      achievedPercent: stats.quarterlyProgress.achievedPercent ?? 0,
                      newBusinessCollected: stats.quarterlyProgress.newBusinessCollected,
                      renewalUpliftCollected: stats.quarterlyProgress.renewalUpliftCollected,
                    }}
                    annual={stats.annualProgress ? {
                      title: 'Annual Target ($250k)',
                      revenueCollected: stats.annualProgress.revenueCollected ?? 0,
                      target: stats.annualProgress.target ?? 250000,
                      achievedPercent: stats.annualProgress.achievedPercent ?? 0,
                      newBusinessCollected: stats.annualProgress.newBusinessCollected,
                      renewalUpliftCollected: stats.annualProgress.renewalUpliftCollected,
                      daysElapsed: stats.annualProgress.daysElapsed,
                      daysRemaining: stats.annualProgress.daysRemaining,
                    } : undefined}
                    bhag={stats.bhagProgress ? {
                      title: 'BHAG ($800k)',
                      revenueCollected: stats.bhagProgress.revenueCollected ?? 0,
                      target: stats.bhagProgress.target ?? 800000,
                      achievedPercent: stats.bhagProgress.achievedPercent ?? 0,
                      newBusinessCollected: stats.bhagProgress.newBusinessCollected,
                      renewalUpliftCollected: stats.bhagProgress.renewalUpliftCollected,
                      daysElapsed: stats.bhagProgress.daysElapsed,
                      daysRemaining: stats.bhagProgress.daysRemaining,
                    } : undefined}
                  />
                </div>
              )}

              {/* 4. Revenue Trend Chart */}
              <div className="mb-6">
                <RevenueTrendChart data={trendData ?? []} />
              </div>

              {/* 5. Secondary Stats Grid */}
              <div className="mb-6">
                <DashboardStatsGrid
                  closedDeals={stats.closedDeals ?? 0}
                  commissionEarned={stats.commissionEarned ?? 0}
                  commissionPending={stats.commissionPending ?? 0}
                  commissionAccruedThisMonth={stats.commissionAccruedThisMonth ?? 0}
                />
              </div>

              {/* 6. Recent Deals */}
              <div className="mb-6">
                <RecentDealsTable deals={displayDeals} viewAllHref="/deals?status=closed-won" />
              </div>
            </>
          )}
        </div>
      </Layout>
    </AuthGuard>
    </ErrorBoundary>
  );
}



