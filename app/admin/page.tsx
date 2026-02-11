'use client';

import { useEffect, useState } from 'react';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { RoleGuard } from '@/components/shared/RoleGuard';
import { Layout } from '@/components/shared/Layout';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default function AdminPage() {
  const [topReps, setTopReps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTopReps = async () => {
      try {
        const res = await fetch('/api/dashboard/top-reps?limit=5');
        if (res.ok) {
          const { safeJsonParse } = await import('@/lib/utils/client-helpers');
          const data = await safeJsonParse(res);
          if (!data.error) {
            setTopReps(data);
          }
        }
      } catch (err) {
        console.error('Failed to fetch top reps:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchTopReps();
  }, []);

  return (
    <AuthGuard>
      <RoleGuard requiredRole="admin">
        <Layout>
          <div className="px-4 py-6 sm:px-0">
            <h2 className="text-2xl font-bold mb-6">Admin Dashboard</h2>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Quick Actions</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <Link href="/admin/reps">
                      <Button variant="outline" className="w-full justify-start">
                        Manage BDR Reps
                      </Button>
                    </Link>
                    <Link href="/admin/rules">
                      <Button variant="outline" className="w-full justify-start">
                        Commission Rules
                      </Button>
                    </Link>
                    <Link href="/admin/targets">
                      <Button variant="outline" className="w-full justify-start">
                        Quarterly Targets
                      </Button>
                    </Link>
                    <Link href="/admin/quarterly">
                      <Button variant="outline" className="w-full justify-start">
                        Enter Quarterly Revenue
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Top Performing Reps</CardTitle>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <div className="space-y-2">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <Skeleton key={i} className="h-8 w-full" />
                      ))}
                    </div>
                  ) : topReps.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No data available</p>
                  ) : (
                    <ul className="space-y-2">
                      {topReps.map((rep, index) => (
                        <li key={rep.id} className="flex justify-between items-center">
                          <span className="text-sm font-medium">
                            {index + 1}. {rep.name}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            ${rep.totalCommission.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </Layout>
      </RoleGuard>
    </AuthGuard>
  );
}





