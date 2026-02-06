'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import useSWR from 'swr';

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || 'Failed to fetch');
  }
  return data;
};

export function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  
  // Use SWR for user data - non-blocking, cached, and fast
  const { data: userData } = useSWR('/api/auth/user', fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60000, // Cache for 60 seconds
    onError: () => {
      // Silently handle errors - user might not be logged in
    },
  });

  const user = userData?.user || null;
  const isAdmin = userData?.role === 'admin' || false;

  const handleLogout = async () => {
    try {
      // Call the signout API endpoint (works for both local and Supabase mode)
      await fetch('/api/auth/signout', { 
        method: 'POST', 
        credentials: 'include' 
      });
    } catch (error) {
      console.error('Logout error:', error);
    }
    // Always redirect to login, even if API call fails
    window.location.href = '/login';
  };

  const isActive = (path: string) => pathname === path;

  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b bg-card">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex">
              <div className="flex-shrink-0 flex items-center">
                <h1 className="text-xl font-bold text-foreground">BDR Commission Tracking</h1>
              </div>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                <Link
                  href="/dashboard"
                  className={cn(
                    "inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-colors",
                    isActive('/dashboard')
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted'
                  )}
                >
                  Dashboard
                </Link>
                <Link
                  href="/clients"
                  className={cn(
                    "inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-colors",
                    isActive('/clients') || pathname?.startsWith('/clients')
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted'
                  )}
                >
                  Clients
                </Link>
                <Link
                  href="/deals"
                  className={cn(
                    "inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-colors",
                    isActive('/deals') || pathname?.startsWith('/deals')
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted'
                  )}
                >
                  Deals
                </Link>
                <Link
                  href="/commission"
                  className={cn(
                    "inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-colors",
                    isActive('/commission') || pathname?.startsWith('/commission')
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted'
                  )}
                >
                  Commission
                </Link>
                {isAdmin && (
                  <Link
                    href="/admin"
                    className={cn(
                      "inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium transition-colors",
                      isActive('/admin') || pathname?.startsWith('/admin')
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted'
                    )}
                  >
                    Admin
                  </Link>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">{user?.email}</span>
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}

