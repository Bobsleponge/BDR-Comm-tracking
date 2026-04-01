'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { format, parseISO } from 'date-fns';

const AreaChart = dynamic(() => import('@tremor/react').then((mod) => mod.AreaChart), {
  ssr: false,
  loading: () => <div className="h-72 animate-pulse rounded bg-muted" />,
});

interface TrendDataPoint {
  month: string;
  amount: number;
}

interface RevenueTrendChartProps {
  data: TrendDataPoint[];
}

export function RevenueTrendChart({ data }: RevenueTrendChartProps) {
  const chartData = useMemo(() => {
    return data.map((d) => ({
      month: format(parseISO(d.month + '-01'), 'MMM yy'),
      'Cash Collected': d.amount,
    }));
  }, [data]);

  if (!data || data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Revenue Trend (Last 12 Months)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Cash collected by month
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex h-64 items-center justify-center text-muted-foreground">
            No revenue data yet
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue Trend (Last 12 Months)</CardTitle>
        <p className="text-sm text-muted-foreground">
          Cash collected by month
        </p>
      </CardHeader>
      <CardContent>
        <AreaChart
          className="h-72"
          data={chartData}
          index="month"
          categories={['Cash Collected']}
          colors={['emerald']}
          valueFormatter={(v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
          showLegend={false}
        />
      </CardContent>
    </Card>
  );
}
