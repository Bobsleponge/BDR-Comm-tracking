'use client';

import { memo } from 'react';
import { Card, Metric } from '@tremor/react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RiInformationLine } from '@remixicon/react';
import { Download } from 'lucide-react';

export type QuarterlyBonusReportType = 'payable' | 'cash' | 'closed_deals';

interface DashboardHeroKPIsProps {
  quarterlyCashCollected: number;
  quarterlyCommissionOnClosedDeals: number;
  quarterlyCommissionBaseAmount?: number;
  projectedQuarterlyBonus: number;
  /** 2.5% on revenue attributed to entries with payable_date in quarter through today. */
  expectedBonusOnCollectedCashToDate: number;
  ytdPayableRevenue?: number;
  currentQuarter?: string;
}

const formatCurrency = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const formatCurrency2 = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function bonusReportUrl(type: QuarterlyBonusReportType, quarter: string, format: 'csv' | 'xlsx') {
  const q = encodeURIComponent(quarter);
  return `/api/dashboard/bonus-calculation-report?type=${type}&quarter=${q}&format=${format}`;
}

export const DashboardHeroKPIs = memo(function DashboardHeroKPIs({
  quarterlyCashCollected,
  quarterlyCommissionOnClosedDeals,
  quarterlyCommissionBaseAmount = 0,
  projectedQuarterlyBonus,
  expectedBonusOnCollectedCashToDate,
  ytdPayableRevenue = 0,
  currentQuarter = '',
}: DashboardHeroKPIsProps) {
  const quarterLabel = currentQuarter ? ` (${currentQuarter})` : '';
  const kpis: Array<{
    title: string;
    value: number;
    formatter: (n: number) => string;
    tooltip: string | null;
    subtitle: string | null;
    bonusReportType?: QuarterlyBonusReportType;
  }> = [
    {
      title: `Quarterly revenue (payable-date through today)${quarterLabel}`,
      value: quarterlyCashCollected,
      formatter: formatCurrency,
      tooltip:
        'Revenue credited to this quarter based on effective payable_date (default close+7, or overridden in app), through today.',
      subtitle: null,
    },
    {
      title: `Quarterly Commission (Closed Deals)${quarterLabel}`,
      value: quarterlyCommissionOnClosedDeals,
      formatter: formatCurrency2,
      tooltip:
        'Bonus commission basis: 2.5% of total deal value for deals with any payable_date in this quarter. New services: full value. Renewals: uplift only. Based on total business done, not cash collected.',
      subtitle:
        quarterlyCommissionBaseAmount > 0 ? `2.5% of ${formatCurrency(quarterlyCommissionBaseAmount)}` : null,
      bonusReportType: 'closed_deals',
    },
    {
      title: `Projected quarter bonus (full quarter)${quarterLabel}`,
      value: projectedQuarterlyBonus,
      formatter: formatCurrency2,
      tooltip:
        'End-of-quarter picture: 2.5% on bonus-eligible revenue for entries whose effective payable_date falls in this quarter (default close+7, or overridden). Includes future payables still inside this quarter.',
      subtitle: null,
      bonusReportType: 'payable',
    },
    {
      title: `Quarterly bonus (payable through today)${quarterLabel}`,
      value: expectedBonusOnCollectedCashToDate,
      formatter: formatCurrency2,
      tooltip:
        '2.5% on bonus-eligible revenue through today for entries with effective payable_date in this quarter (default close+7, or overridden).',
      subtitle: null,
      bonusReportType: 'cash',
    },
    {
      title: 'YTD Revenue (payable-date through today)',
      value: ytdPayableRevenue,
      formatter: formatCurrency,
      tooltip:
        'Year-to-date revenue credited by effective payable_date through today (default close+7, or overridden).',
      subtitle: null,
    },
  ];

  return (
    <TooltipProvider>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {kpis.map((kpi) => (
          <Card key={kpi.title} className="p-4">
            <div className="flex items-start justify-between gap-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1 min-w-0">
                <span className="leading-tight">{kpi.title}</span>
                {kpi.tooltip && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex shrink-0 cursor-help text-muted-foreground hover:text-foreground">
                        <RiInformationLine className="h-3.5 w-3.5" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      {kpi.tooltip}
                    </TooltipContent>
                  </Tooltip>
                )}
              </p>
              {kpi.bonusReportType && currentQuarter && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label="Download quarterly bonus calculation report"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => window.open(bonusReportUrl(kpi.bonusReportType!, currentQuarter, 'xlsx'), '_blank')}
                    >
                      Excel (.xlsx)
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => window.open(bonusReportUrl(kpi.bonusReportType!, currentQuarter, 'csv'), '_blank')}
                    >
                      CSV
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <Metric className="mt-1">{kpi.formatter(kpi.value)}</Metric>
            {kpi.subtitle && <p className="mt-1 text-sm text-muted-foreground">{kpi.subtitle}</p>}
          </Card>
        ))}
      </div>
    </TooltipProvider>
  );
});
