'use client';

import { useState, useEffect } from 'react';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import useSWR from 'swr';

interface Client {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
}

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
      const { safeJsonParse } = await import('@/lib/utils/client-helpers');
  const data = await safeJsonParse(res);
  if (!res.ok || data.error) {
    throw new Error(data.error || `Failed to fetch: ${res.statusText}`);
  }
  return data;
};

export default function ClientsPage() {
  const [searchTerm, setSearchTerm] = useState('');
  
  // Debounce search to avoid too many requests
  const [debouncedSearch, setDebouncedSearch] = useState('');
  
  // Debounce search term
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const url = debouncedSearch
    ? `/api/clients?search=${encodeURIComponent(debouncedSearch)}`
    : '/api/clients';

  const { data: clientsRaw, error, isLoading: loading } = useSWR<any>(url, fetcher, {
    revalidateOnFocus: false,
    revalidateOnReconnect: true,
    dedupingInterval: 5000,
  });
  
  // Extract clients array from paginated response
  const clients: Client[] = Array.isArray(clientsRaw) 
    ? clientsRaw 
    : (clientsRaw?.data || []);

  if (loading) {
    return (
      <AuthGuard>
        <Layout>
          <div className="px-4 py-6 sm:px-0 space-y-6">
            <div className="flex justify-between items-center">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-10 w-32" />
            </div>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </Layout>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <Layout>
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6 flex justify-between items-center">
            <h2 className="text-2xl font-bold">Clients</h2>
            <Link href="/clients/new">
              <Button>New Client</Button>
            </Link>
          </div>

          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error.message || 'Failed to load clients'}</AlertDescription>
            </Alert>
          )}

          <div className="mb-4">
            <Input
              type="text"
              placeholder="Search clients..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>All Clients</CardTitle>
            </CardHeader>
            <CardContent>
              {clients.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No clients found. <Link href="/clients/new" className="text-primary hover:underline">Create one</Link>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Company</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {clients.map((client) => (
                        <TableRow key={client.id}>
                          <TableCell className="font-medium">{client.name}</TableCell>
                          <TableCell>{client.company || '-'}</TableCell>
                          <TableCell>{client.email || '-'}</TableCell>
                          <TableCell>{client.phone || '-'}</TableCell>
                          <TableCell>
                            <Link href={`/clients/${client.id}`}>
                              <Button variant="ghost" size="sm">View</Button>
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </Layout>
    </AuthGuard>
  );
}



