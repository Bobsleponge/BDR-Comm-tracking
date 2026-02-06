'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DollarSign, Clock, X, TrendingUp } from 'lucide-react';

interface CommissionSummaryProps {
  earned: number;
  pending: number;
  cancelled: number;
  total: number;
}

export function CommissionSummary({
  earned,
  pending,
  cancelled,
  total,
}: CommissionSummaryProps) {
  const cards = [
    {
      name: 'Earned',
      value: earned,
      icon: DollarSign,
      color: 'text-green-600',
      bgColor: 'bg-green-100',
    },
    {
      name: 'Pending',
      value: pending,
      icon: Clock,
      color: 'text-yellow-600',
      bgColor: 'bg-yellow-100',
    },
    {
      name: 'Cancelled',
      value: cancelled,
      icon: X,
      color: 'text-red-600',
      bgColor: 'bg-red-100',
    },
    {
      name: 'Total',
      value: total,
      icon: TrendingUp,
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.name}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.name}
              </CardTitle>
              <div className={`${card.bgColor} ${card.color} p-2 rounded-lg`}>
                <Icon className="h-4 w-4" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${card.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}





