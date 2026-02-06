'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';

export function RoleGuard({ 
  children, 
  requiredRole = 'admin' 
}: { 
  children: React.ReactNode;
  requiredRole?: 'admin' | 'bdr';
}) {
  const [loading, setLoading] = useState(true);
  const [hasAccess, setHasAccess] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const checkRole = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push('/login');
        return;
      }

      if (requiredRole === 'admin') {
        const role = user.user_metadata?.role;
        if (role === 'admin') {
          setHasAccess(true);
        } else {
          router.push('/dashboard');
        }
      } else {
        setHasAccess(true);
      }
      setLoading(false);
    };

    checkRole();
  }, [router, supabase, requiredRole]);

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

  if (!hasAccess) {
    return null;
  }

  return <>{children}</>;
}





