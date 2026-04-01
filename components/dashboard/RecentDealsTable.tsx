'use client';

import { memo, useMemo } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Deal {
  id: string;
  client_name: string;
  service_type: string;
  deal_value: number;
  status: 'proposed' | 'closed-won' | 'closed-lost';
  close_date: string | null;
  created_at: string;
  has_override?: boolean;
}

interface RecentDealsTableProps {
  deals: Deal[];
  viewAllHref?: string;
}

export const RecentDealsTable = memo(function RecentDealsTable({ deals, viewAllHref }: RecentDealsTableProps) {
  const getStatusVariant = useMemo(() => (status: string): "default" | "secondary" | "destructive" | "outline" => {
    if (status === 'closed-won') return 'default';
    if (status === 'closed-lost') return 'destructive';
    return 'secondary';
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Recent Deals</CardTitle>
          {viewAllHref && (
            <Link href={viewAllHref}>
              <Button variant="ghost" size="sm">View all</Button>
            </Link>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Close Date</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No recent deals
                  </TableCell>
                </TableRow>
              ) : (
                deals.map((deal) => (
                  <TableRow key={deal.id}>
                    <TableCell className="font-medium">{deal.client_name}</TableCell>
                    <TableCell>{deal.service_type}</TableCell>
                    <TableCell>
                      ${deal.deal_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={getStatusVariant(deal.status)}>
                          {deal.status.replace('-', ' ')}
                        </Badge>
                        {deal.has_override && (
                          <Badge variant="outline" className="font-normal text-amber-700 bg-amber-50 border-amber-200">
                            Override
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {deal.close_date ? format(new Date(deal.close_date), 'MMM d, yyyy') : '-'}
                    </TableCell>
                    <TableCell>
                      <Link href={`/deals/${deal.id}`}>
                        <Button variant="ghost" size="sm">View</Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
});



