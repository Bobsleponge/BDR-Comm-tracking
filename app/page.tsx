'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/auth/user', { credentials: 'include' });
        const data = await res.json();
        if (data.user) {
          router.push('/dashboard');
        } else {
          router.push('/login');
        }
      } catch (error) {
        // If auth check fails, redirect to login
        router.push('/login');
      }
    };

    checkAuth();
  }, [router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm">
        <h1 className="text-4xl font-bold mb-4">BDR Commission Tracking</h1>
        <div className="space-y-2">
          <div className="h-4 w-48 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-32 bg-gray-200 rounded animate-pulse" />
        </div>
      </div>
    </main>
  );
}

