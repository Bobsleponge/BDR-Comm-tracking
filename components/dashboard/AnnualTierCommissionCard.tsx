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
  remainingToThreshold: number;
  inTier2: boolean;
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
  const tier1Cap = Math.min(annualTier.revenueCollected, annualTier.threshold);
  const tier1Percent = annualTier.threshold > 0 ? Math.min((tier1Cap / annualTier.threshold) * 100, 100) : 0;
  const tier2Percent =
    annualTier.revenueCollected > annualTier.threshold
      ? Math.min(((annualTier.revenueCollected - annualTier.threshold) / annualTier.threshold) * 100, 100)
      : 0;

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
            Annual tier commission ({annualTier.year})
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-help text-muted-foreground hover:text-foreground">
                  <RiInformationLine className="h-3.5 w-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Calendar-year commissionable cash collected through today. Revenue up to the annual threshold is modeled
                at {formatRate(annualTier.tier1Rate)}; revenue above the threshold is modeled at {formatRate(annualTier.tier2Rate)}.
                Quarterly payable-date bonus is separate.
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
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Tier 1 revenue ({formatRate(annualTier.tier1Rate)} up to {formatCurrency(annualTier.threshold)})</span>
              <span>{formatCurrency(annualTier.revenueInTier1)}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${tier1Percent}%` }} />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Tier 2 revenue ({formatRate(annualTier.tier2Rate)} above threshold)</span>
              <span>{formatCurrency(annualTier.revenueInTier2)}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-all"
                style={{ width: `${tier2Percent}%` }}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">YTD collected</p>
              <p className="text-lg font-semibold">{formatCurrency(annualTier.revenueCollected)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                {annualTier.inTier2 ? 'Above threshold' : 'To threshold'}
              </p>
              <p className="text-lg font-semibold">
                {annualTier.inTier2 ? formatCurrency(annualTier.revenueInTier2) : formatCurrency(annualTier.remainingToThreshold)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Tier 1 commission</p>
              <p className="text-lg font-semibold">{formatCurrency2(annualTier.tier1Commission)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Tier 2 commission</p>
              <p className="text-lg font-semibold">{formatCurrency2(annualTier.tier2Commission)}</p>
            </div>
          </div>
          <div className="flex justify-between border-t pt-3 text-sm">
            <span className="text-muted-foreground">Modeled annual tier commission</span>
            <span className="font-semibold">{formatCurrency2(annualTier.totalTierCommission)}</span>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
});
