'use client';

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface QuarterlyProgressProps {
  revenueCollected: number;
  target: number;
  achievedPercent: number;
  bonusEligible: boolean;
  quarter: string;
}

export const QuarterlyProgressBar = memo(function QuarterlyProgressBar({
  revenueCollected,
  target,
  achievedPercent,
  bonusEligible,
  quarter,
}: QuarterlyProgressProps) {
  const progressPercent = useMemo(() => Math.min(achievedPercent, 100), [achievedPercent]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quarterly Progress - {quarter}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Revenue Collected</span>
            <span className="font-semibold">
              ${revenueCollected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Target</span>
            <span className="font-semibold">
              ${target.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="w-full bg-secondary rounded-full h-4">
            <div
              className={`h-4 rounded-full transition-all ${
                bonusEligible ? 'bg-green-500' : progressPercent >= 75 ? 'bg-yellow-500' : 'bg-primary'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground">Progress</span>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{achievedPercent.toFixed(1)}%</span>
              {bonusEligible && (
                <Badge variant="default" className="bg-green-500">
                  Bonus Eligible
                </Badge>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
});





