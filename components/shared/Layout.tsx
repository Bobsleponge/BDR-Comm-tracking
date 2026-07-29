'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import useSWR from 'swr';

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  const { safeJsonParse } = await import('@/lib/utils/client-helpers');
  const data = await safeJsonParse(res);
  if (!res.ok || data?.error) {
    throw new Error(data?.error || 'Failed to fetch');
  }
  return data;
};

const navLinks = [
  { href: '/dashboard', label: 'Dashboard', match: (pathname: string) => pathname === '/dashboard' },
  {
    href: '/clients',
    label: 'Clients',
    match: (pathname: string) => pathname === '/clients' || pathname.startsWith('/clients/'),
  },
  {
    href: '/deals',
    label: 'Deals',
    match: (pathname: string) => pathname === '/deals' || pathname.startsWith('/deals/'),
  },
  {
    href: '/commission',
    label: 'Commission',
    match: (pathname: string) => pathname === '/commission' || pathname.startsWith('/commission/'),
  },
] as const;

export function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const { data: userData } = useSWR('/api/auth/user', fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60000,
    onError: () => {},
  });

  const user = userData?.user || null;
  const isAdmin = userData?.role === 'admin' || false;

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/signout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      console.error('Logout error:', error);
    }
    window.location.href = '/login';
  };

  const linkClassName = (active: boolean) =>
    cn(
      'inline-flex shrink-0 items-center border-b-2 px-1 pt-1 text-sm font-medium transition-colors',
      active
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:border-muted hover:text-foreground'
    );

  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b bg-card">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <h1 className="shrink-0 text-xl font-bold text-foreground">BDR Commission Tracking</h1>
              <div className="hidden min-w-0 flex-1 gap-6 overflow-x-auto sm:flex sm:space-x-8">
                {navLinks.map((link) => (
                  <Link key={link.href} href={link.href} className={linkClassName(link.match(pathname || ''))}>
                    {link.label}
                  </Link>
                ))}
                {isAdmin && (
                  <Link
                    href="/admin"
                    className={linkClassName(
                      pathname === '/admin' || Boolean(pathname?.startsWith('/admin/'))
                    )}
                  >
                    Admin
                  </Link>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-4">
              <span className="hidden text-sm text-muted-foreground sm:inline">{user?.email}</span>
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                Sign out
              </Button>
            </div>
          </div>
          <div className="-mt-1 flex gap-4 overflow-x-auto border-t pb-3 pt-2 sm:hidden">
            {navLinks.map((link) => (
              <Link key={link.href} href={link.href} className={linkClassName(link.match(pathname || ''))}>
                {link.label}
              </Link>
            ))}
            {isAdmin && (
              <Link
                href="/admin"
                className={linkClassName(pathname === '/admin' || Boolean(pathname?.startsWith('/admin/')))}
              >
                Admin
              </Link>
            )}
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-7xl py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
