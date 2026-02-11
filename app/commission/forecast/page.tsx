'use client';

import { useEffect, useState } from 'react';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { CommissionForecastChart } from '@/components/commission/CommissionForecastChart';

interface ForecastData {
  month: string;
  amount: number;
}

export default function CommissionForecastPage() {
  const [forecast, setForecast] = useState<ForecastData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchForecast = async () => {
      try {
        const res = await fetch('/api/commission/forecast?months=12');
        if (!res.ok) throw new Error('Failed to fetch forecast');
        const { safeJsonParse } = await import('@/lib/utils/client-helpers');
        const data = await safeJsonParse(res);
        if (data.error) throw new Error(data.error);
        setForecast(data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchForecast();
  }, []);

  if (loading) {
    return (
      <AuthGuard>
        <Layout>
          <div className="flex items-center justify-center min-h-screen">
            <div className="text-lg">Loading forecast...</div>
          </div>
        </Layout>
      </AuthGuard>
    );
  }

  if (error) {
    return (
      <AuthGuard>
        <Layout>
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            Error: {error}
          </div>
        </Layout>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <Layout>
        <div className="px-4 py-6 sm:px-0">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Commission Forecast</h2>
          <CommissionForecastChart data={forecast} />
        </div>
      </Layout>
    </AuthGuard>
  );
}







