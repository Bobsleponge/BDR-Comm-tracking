'use client';

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { RiInformationLine } from '@remixicon/react';
import { Download } from 'lucide-react';

export interface AnnualTierSummaryView {
  year: number;
  threshold: number;
  tier1Rate: number;
  tier2Rate: number;
  revenueCollected: number;
  revenueInTier1: number;
  revenueInTier2: number;
  tier1Commission: number;
  tier2Commission: number;
  totalTierCommission: number;
  tier2ExtraCommission: number;
  remainingToThreshold: number;
  inTier2: boolean;
  projectedRevenueCollected: number;
  projectedRevenueInTier1: number;
  projectedRevenueInTier2: number;
  projectedTier1Commission: number;
  projectedTier2Commission: number;
  projectedTotalTierCommission: number;
  projectedTier2ExtraCommission: number;
}

interface AnnualTierCommissionCardProps {
  annualTier: AnnualTierSummaryView;
}

const formatCurrency = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const formatCurrency2 = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatRate = (rate: number) => `${(rate * 100).toFixed(1)}%`;

function annualTierReportUrl(year: number, format: 'csv' | 'xlsx') {
  return `/api/dashboard/annual-tier-report?year=${encodeURIComponent(String(year))}&format=${format}&t=${Date.now()}`;
}

export const AnnualTierCommissionCard = memo(function AnnualTierCommissionCard({
  annualTier,
}: AnnualTierCommissionCardProps) {
  const extraRate = Math.max(0, annualTier.tier2Rate - annualTier.tier1Rate);
  const projectedAboveGoal = annualTier.projectedRevenueInTier2;
  const collectedGoalPercent =
    annualTier.threshold > 0
      ? Math.min((annualTier.revenueCollected / annualTier.threshold) * 100, 100)
      : 0;
  const expectedGoalPercent =
    annualTier.threshold > 0 ? (annualTier.projectedRevenueCollected / annualTier.threshold) * 100 : 0;
  const stillToGoal = Math.max(0, annualTier.threshold - annualTier.projectedRevenueCollected);

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
            Annual goal bonus ({annualTier.year})
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-help text-muted-foreground hover:text-foreground">
                  <RiInformationLine className="h-3.5 w-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Expected cash is commissionable revenue already collected plus scheduled collections still expected this
                year. The extra {formatRate(extraRate)} is modeled on cash above the {formatCurrency(annualTier.threshold)}{' '}
                annual goal and paid at year-end. Quarterly bonus is separate.
              </TooltipContent>
            </Tooltip>
          </CardTitle>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.open(annualTierReportUrl(annualTier.year, 'xlsx'), '_blank')}
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Excel
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => window.open(annualTierReportUrl(annualTier.year, 'csv'), '_blank')}
            >
              CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Expected cash collected this year, and the extra {formatRate(extraRate)} on cash above the{' '}
            {formatCurrency(annualTier.threshold)} annual goal (paid at year-end).
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">Expected cash collected</p>
              <p className="mt-1 text-2xl font-semibold">{formatCurrency(annualTier.projectedRevenueCollected)}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Collected so far: {formatCurrency(annualTier.revenueCollected)} ({collectedGoalPercent.toFixed(0)}% of
                goal)
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {expectedGoalPercent >= 100
                  ? `Forecast is ${expectedGoalPercent.toFixed(0)}% of the ${formatCurrency(annualTier.threshold)} goal`
                  : `Forecast reaches ${expectedGoalPercent.toFixed(0)}% of the ${formatCurrency(annualTier.threshold)} goal`}
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">
                Extra {formatRate(extraRate)} at year-end
              </p>
              <p className="mt-1 text-2xl font-semibold">{formatCurrency2(annualTier.projectedTier2ExtraCommission)}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {projectedAboveGoal > 0
                  ? `On ${formatCurrency(projectedAboveGoal)} above the ${formatCurrency(annualTier.threshold)} goal`
                  : stillToGoal > 0
                    ? `${formatCurrency(stillToGoal)} still needed to reach the goal`
                    : 'No cash above the goal in the current forecast'}
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Collected so far toward {formatCurrency(annualTier.threshold)} goal</span>
              <span>{collectedGoalPercent.toFixed(0)}%</span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${collectedGoalPercent}%` }}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
});
