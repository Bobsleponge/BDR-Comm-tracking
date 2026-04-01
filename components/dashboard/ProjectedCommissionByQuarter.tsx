'use client';

import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProgressBar } from '@tremor/react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { RiInformationLine } from '@remixicon/react';

export interface QuarterlyProgressItem {
  revenue: number;
  commission: number;
  bonus: number;
  target: number;
  achievedPercent: number;
}

interface ProjectedCommissionByQuarterProps {
  quarterlyProgressByQuarter?: Record<string, QuarterlyProgressItem>;
  projectedCommissionByQuarter?: Record<string, number>;
  currentQuarter?: string;
}

const formatCurrency = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BONUS_RATE = 0.025;

export const ProjectedCommissionByQuarter = memo(function ProjectedCommissionByQuarter({
  quarterlyProgressByQuarter = {},
  projectedCommissionByQuarter = {},
  currentQuarter = '',
}: ProjectedCommissionByQuarterProps) {
  const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
  const year = currentQuarter ? currentQuarter.split('-')[0] : new Date().getFullYear().toString();

  const rows = quarters.map((q) => {
    const key = `${year}-${q}`;
    const progress = quarterlyProgressByQuarter[key];
    const revenue = progress?.revenue ?? 0;
    const bonus = progress?.bonus ?? 0;
    const expectedBonus = projectedCommissionByQuarter[key] ?? 0;
    const estimatedRevenue = expectedBonus / BONUS_RATE;
    const target = progress?.target ?? 75000;
    const achievedPercent = progress?.achievedPercent ?? 0;
    const estimatedPercent = target > 0 ? (estimatedRevenue / target) * 100 : 0;
    const isCurrent = currentQuarter === key;
    return {
      quarter: key,
      label: q,
      revenue,
      bonus,
      expectedBonus,
      estimatedRevenue,
      target,
      achievedPercent,
      estimatedPercent,
      isCurrent,
    };
  });

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
            Quarterly Goal Progress (Payable-Date Basis)
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-help text-muted-foreground hover:text-foreground">
                  <RiInformationLine className="h-3.5 w-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                Progress toward each quarter&apos;s target using effective payable dates (default close+7, or overridden in app).
                Includes through-today progress and full-quarter projection on the same payable-date basis.
              </TooltipContent>
            </Tooltip>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {rows.map(({ quarter, label, revenue, bonus, expectedBonus, estimatedRevenue, target, achievedPercent, estimatedPercent, isCurrent }) => (
              <div
                key={quarter}
                className={`rounded-lg border p-4 ${isCurrent ? 'border-primary bg-primary/5' : 'border-muted'}`}
              >
                <div className="text-xs font-medium text-muted-foreground flex items-center justify-between gap-1">
                  <span className="flex items-center gap-1">
                    {year}-{label}
                    {isCurrent && (
                      <span className="rounded bg-primary/20 px-1 py-0.5 text-[10px] text-primary">Current</span>
                    )}
                  </span>
                </div>
                <div className="mt-2 space-y-2">
                  <div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Payable through today vs target</span>
                      <span>
                        {formatCurrency(revenue)} / {formatCurrency(target)}
                      </span>
                    </div>
                    <ProgressBar
                      value={Math.min(achievedPercent, 100)}
                      color={achievedPercent >= 100 ? 'emerald' : achievedPercent >= 50 ? 'green' : achievedPercent >= 25 ? 'yellow' : 'red'}
                      showAnimation
                      className="h-2 mt-0.5"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Estimated full-quarter payable vs target</span>
                      <span>
                        {formatCurrency(estimatedRevenue)} / {formatCurrency(target)}
                      </span>
                    </div>
                    <ProgressBar
                      value={Math.min(estimatedPercent, 100)}
                      color={estimatedPercent >= 100 ? 'emerald' : estimatedPercent >= 50 ? 'green' : estimatedPercent >= 25 ? 'yellow' : 'red'}
                      showAnimation
                      className="h-2 mt-0.5"
                    />
                  </div>
                  <div className="pt-1 space-y-0.5">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Bonus through today (2.5%)</span>
                      <span className="font-medium">{formatCurrency(bonus)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Expected full-quarter bonus</span>
                      <span className="font-medium">{formatCurrency(expectedBonus)}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
});
