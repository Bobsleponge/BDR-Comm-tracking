'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface TargetProgress {
  title: string;
  revenueCollected: number;
  target: number;
  achievedPercent: number;
}

interface TargetProgressChartProps {
  quarterly?: TargetProgress;
  annual?: TargetProgress;
  bhag?: TargetProgress;
}

export function TargetProgressChart({
  quarterly,
  annual,
  bhag,
}: TargetProgressChartProps) {
  const targets = useMemo(() => {
    const items: Array<{
      title: string;
      collected: number;
      target: number;
      percent: number;
      color: string;
      bgColor: string;
    }> = [];

    if (quarterly) {
      items.push({
        title: 'Quarterly',
        collected: quarterly.revenueCollected,
        target: quarterly.target,
        percent: quarterly.achievedPercent,
        color: 'text-blue-600',
        bgColor: 'bg-blue-500',
      });
    }

    if (annual) {
      items.push({
        title: 'Annual',
        collected: annual.revenueCollected,
        target: annual.target,
        percent: annual.achievedPercent,
        color: 'text-green-600',
        bgColor: 'bg-green-500',
      });
    }

    if (bhag) {
      items.push({
        title: 'BHAG',
        collected: bhag.revenueCollected,
        target: bhag.target,
        percent: bhag.achievedPercent,
        color: 'text-purple-600',
        bgColor: 'bg-purple-500',
      });
    }

    return items;
  }, [quarterly, annual, bhag]);

  if (targets.length === 0) {
    return null;
  }

  const getProgressColor = (percent: number) => {
    if (percent >= 100) return 'bg-green-500';
    if (percent >= 75) return 'bg-green-400';
    if (percent >= 50) return 'bg-yellow-500';
    if (percent >= 25) return 'bg-yellow-400';
    return 'bg-red-500';
  };

  const getStatusText = (percent: number) => {
    if (percent >= 100) return { text: 'Target Achieved!', color: 'text-green-600' };
    if (percent >= 75) return { text: 'On Track', color: 'text-green-600' };
    if (percent >= 50) return { text: 'Making Progress', color: 'text-yellow-600' };
    if (percent >= 25) return { text: 'Getting Started', color: 'text-yellow-600' };
    return { text: 'Needs Attention', color: 'text-red-600' };
  };

  // Check if annual and BHAG are both present (they track the same revenue)
  const hasBothAnnualTargets = annual && bhag;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Target Progress Overview</CardTitle>
        {hasBothAnnualTargets && (
          <p className="text-sm text-muted-foreground mt-2">
            Note: Annual Target and BHAG both track the same annual revenue collected, but with different target amounts.
          </p>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {targets.map((target) => {
            const progressPercent = Math.min(target.percent, 100);
            const remaining = Math.max(0, target.target - target.collected);
            const status = getStatusText(target.percent);
            const progressColor = getProgressColor(target.percent);

            return (
              <div key={target.title} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">{target.title}</h3>
                  <span className={`text-sm font-medium ${status.color}`}>
                    {status.text}
                  </span>
                </div>

                {/* Circular Progress Indicator */}
                <div className="relative w-32 h-32 mx-auto">
                  <svg className="transform -rotate-90 w-32 h-32">
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      stroke="currentColor"
                      strokeWidth="8"
                      fill="none"
                      className="text-gray-200"
                    />
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      stroke="currentColor"
                      strokeWidth="8"
                      fill="none"
                      strokeDasharray={`${2 * Math.PI * 56}`}
                      strokeDashoffset={`${2 * Math.PI * 56 * (1 - progressPercent / 100)}`}
                      strokeLinecap="round"
                      className={progressColor.replace('bg-', 'text-')}
                      style={{ transition: 'stroke-dashoffset 0.5s ease-in-out' }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <div className="text-2xl font-bold">{progressPercent.toFixed(0)}%</div>
                    </div>
                  </div>
                </div>

                {/* Revenue Details */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Collected</span>
                    <span className="text-sm font-semibold">
                      ${target.collected.toLocaleString('en-US', {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Target</span>
                    <span className="text-sm font-semibold">
                      ${target.target.toLocaleString('en-US', {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  </div>
                  {remaining > 0 && (
                    <div className="flex justify-between items-center pt-2 border-t">
                      <span className="text-sm text-muted-foreground">Remaining</span>
                      <span className="text-sm font-semibold text-red-600">
                        ${remaining.toLocaleString('en-US', {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 0,
                        })}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
