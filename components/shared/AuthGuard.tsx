'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import useSWR from 'swr';

const fetcher = async (url: string) => {
  try {
    const res = await fetch(url, { credentials: 'include' });
    const { safeJsonParse } = await import('@/lib/utils/client-helpers');
    const data = await safeJsonParse(res);
    return data;
  } catch (error) {
    throw error;
  }
};

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  
  // Use SWR for fast, cached auth check - non-blocking
  const { data, isLoading } = useSWR('/api/auth/user', fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60000, // Cache for 60 seconds
  });

  const authenticated = !!data?.user;
  const loading = isLoading && !data;

  // Redirect to login if not authenticated (but not if already on login page)
  useEffect(() => {
    if (!loading && !authenticated && pathname !== '/login') {
      router.push('/login');
    }
  }, [loading, authenticated, pathname, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return null;
  }

  return <>{children}</>;
}

