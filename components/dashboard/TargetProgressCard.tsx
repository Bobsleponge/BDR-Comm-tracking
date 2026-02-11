'use client';

import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface TargetProgressCardProps {
  title: string;
  revenueCollected: number;
  target: number;
  achievedPercent: number;
  daysElapsed?: number;
  daysRemaining?: number;
}

export const TargetProgressCard = memo(function TargetProgressCard({
  title,
  revenueCollected,
  target,
  achievedPercent,
  daysElapsed,
  daysRemaining,
}: TargetProgressCardProps) {
  const progressPercent = useMemo(() => Math.min(achievedPercent, 100), [achievedPercent]);
  const remaining = useMemo(() => Math.max(0, target - revenueCollected), [target, revenueCollected]);

  // Determine color based on progress
  const progressColor = useMemo(() => {
    if (progressPercent >= 100) return 'bg-green-500';
    if (progressPercent >= 75) return 'bg-green-400';
    if (progressPercent >= 50) return 'bg-yellow-500';
    if (progressPercent >= 25) return 'bg-yellow-400';
    return 'bg-red-500';
  }, [progressPercent]);

  // Calculate time-based pacing if days info is available
  const timeContext = useMemo(() => {
    if (daysElapsed !== undefined && daysRemaining !== undefined) {
      const totalDays = daysElapsed + daysRemaining;
      const timeElapsedPercent = (daysElapsed / totalDays) * 100;
      const onTrack = progressPercent >= timeElapsedPercent * 0.9; // 90% of time-based progress
      
      return {
        daysElapsed,
        daysRemaining,
        timeElapsedPercent,
        onTrack,
      };
    }
    return null;
  }, [daysElapsed, daysRemaining, progressPercent]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{title}</CardTitle>
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
              className={`h-4 rounded-full transition-all ${progressColor}`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-semibold">{achievedPercent.toFixed(1)}%</span>
          </div>
          {remaining > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Remaining</span>
              <span className="font-semibold">
                ${remaining.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
          {timeContext && (
            <div className="pt-2 border-t">
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Time Progress</span>
                <span>Day {timeContext.daysElapsed} of {timeContext.daysElapsed + timeContext.daysRemaining}</span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div
                  className="h-2 rounded-full bg-blue-400"
                  style={{ width: `${timeContext.timeElapsedPercent}%` }}
                />
              </div>
              {timeContext.onTrack ? (
                <div className="text-xs text-green-600 mt-1">✓ On track</div>
              ) : (
                <div className="text-xs text-yellow-600 mt-1">⚠ Behind pace</div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
});



