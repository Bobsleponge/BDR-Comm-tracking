'use client';

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { format, parseISO } from 'date-fns';

interface ForecastData {
  month: string;
  amount: number;
}

interface CommissionForecastChartProps {
  data: ForecastData[];
}

export function CommissionForecastChart({ data }: CommissionForecastChartProps) {
  const chartData = data.map(item => ({
    month: format(parseISO(item.month), 'MMM yyyy'),
    amount: item.amount,
  }));

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-4">12-Month Commission Forecast</h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis 
            dataKey="month" 
            angle={-45}
            textAnchor="end"
            height={80}
          />
          <YAxis />
          <Tooltip 
            formatter={(value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          />
          <Legend />
          <Line 
            type="monotone" 
            dataKey="amount" 
            stroke="#4F46E5" 
            strokeWidth={2}
            name="Commission"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}







