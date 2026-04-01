'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProgressBar } from '@tremor/react';

interface TargetProgress {
  title: string;
  revenueCollected: number;
  target: number;
  achievedPercent: number;
  newBusinessCollected?: number;
  renewalUpliftCollected?: number;
  daysElapsed?: number;
  daysRemaining?: number;
}

interface TargetProgressChartProps {
  quarterly?: TargetProgress;
  annual?: TargetProgress;
  bhag?: TargetProgress;
}

function getProgressColor(percent: number): 'emerald' | 'green' | 'yellow' | 'amber' | 'red' {
  if (percent >= 100) return 'emerald';
  if (percent >= 75) return 'green';
  if (percent >= 50) return 'yellow';
  if (percent >= 25) return 'amber';
  return 'red';
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
      newBusinessCollected?: number;
      renewalUpliftCollected?: number;
      daysElapsed?: number;
      daysRemaining?: number;
    }> = [];

    if (quarterly) {
      items.push({
        title: 'Quarterly',
        collected: quarterly.revenueCollected,
        target: quarterly.target,
        percent: quarterly.achievedPercent,
        newBusinessCollected: quarterly.newBusinessCollected,
        renewalUpliftCollected: quarterly.renewalUpliftCollected,
      });
    }

    if (annual) {
      items.push({
        title: 'Annual',
        collected: annual.revenueCollected,
        target: annual.target,
        percent: annual.achievedPercent,
        newBusinessCollected: annual.newBusinessCollected,
        renewalUpliftCollected: annual.renewalUpliftCollected,
        daysElapsed: annual.daysElapsed,
        daysRemaining: annual.daysRemaining,
      });
    }

    if (bhag) {
      items.push({
        title: 'BHAG',
        collected: bhag.revenueCollected,
        target: bhag.target,
        percent: bhag.achievedPercent,
        newBusinessCollected: bhag.newBusinessCollected,
        renewalUpliftCollected: bhag.renewalUpliftCollected,
        daysElapsed: bhag.daysElapsed,
        daysRemaining: bhag.daysRemaining,
      });
    }

    return items;
  }, [quarterly, annual, bhag]);

  if (targets.length === 0) {
    return null;
  }

  const getStatusText = (percent: number) => {
    if (percent >= 100) return { text: 'Target Achieved!', color: 'text-green-600' };
    if (percent >= 75) return { text: 'On Track', color: 'text-green-600' };
    if (percent >= 50) return { text: 'Making Progress', color: 'text-yellow-600' };
    if (percent >= 25) return { text: 'Getting Started', color: 'text-yellow-600' };
    return { text: 'Needs Attention', color: 'text-red-600' };
  };

  const hasBothAnnualTargets = annual && bhag;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Target Progress Overview</CardTitle>
        <p className="text-sm text-muted-foreground mt-2">
          All goals are based on actual cash collected: new business uses full amount claimed; renewals use uplift amount only.
        </p>
        {hasBothAnnualTargets && (
          <p className="text-sm text-muted-foreground mt-1">
            Note: Annual Target and BHAG both track the same annual cash collected, but with different target amounts.
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

            // Time-based pacing for annual targets
            const totalDays = (target.daysElapsed ?? 0) + (target.daysRemaining ?? 0);
            const timeElapsedPercent = totalDays > 0 ? (target.daysElapsed ?? 0) / totalDays * 100 : 0;
            const onTrack = totalDays > 0 && progressPercent >= timeElapsedPercent * 0.9;

            return (
              <div key={target.title} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">{target.title}</h3>
                  <span className={`text-sm font-medium ${status.color}`}>
                    {status.text}
                  </span>
                </div>

                <ProgressBar
                  value={progressPercent}
                  color={progressColor}
                  showAnimation
                  className="mt-2"
                />
                <div className="text-center text-2xl font-bold">{progressPercent.toFixed(0)}%</div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Cash Collected</span>
                    <span className="text-sm font-semibold">
                      ${target.collected.toLocaleString('en-US', {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  </div>
                  {(target.newBusinessCollected != null || target.renewalUpliftCollected != null) && (
                    <div className="space-y-1 pl-2 border-l-2 border-muted">
                      {target.newBusinessCollected != null && target.newBusinessCollected > 0 && (
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-muted-foreground">New business</span>
                          <span>${target.newBusinessCollected.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                        </div>
                      )}
                      {target.renewalUpliftCollected != null && target.renewalUpliftCollected > 0 && (
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-muted-foreground">Renewal uplift</span>
                          <span>${target.renewalUpliftCollected.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                        </div>
                      )}
                    </div>
                  )}
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
                  {target.daysElapsed != null && target.daysRemaining != null && totalDays > 0 && (
                    <div className="pt-2 border-t">
                      <div className="flex justify-between text-xs text-muted-foreground mb-1">
                        <span>Time Progress</span>
                        <span>Day {target.daysElapsed} of {totalDays}</span>
                      </div>
                      <div className="w-full bg-secondary rounded-full h-2">
                        <div
                          className="h-2 rounded-full bg-blue-400 transition-all"
                          style={{ width: `${timeElapsedPercent}%` }}
                        />
                      </div>
                      {onTrack ? (
                        <div className="text-xs text-green-600 mt-1">On track</div>
                      ) : (
                        <div className="text-xs text-yellow-600 mt-1">Behind pace</div>
                      )}
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
