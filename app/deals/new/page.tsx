'use client';

import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { DealForm } from '@/components/deals/DealForm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function NewDealPage() {
  return (
    <AuthGuard>
      <Layout>
        <div className="px-4 py-6 sm:px-0">
          <h2 className="text-2xl font-bold mb-6">New Deal</h2>
          <Card>
            <CardHeader>
              <CardTitle>Deal Information</CardTitle>
            </CardHeader>
            <CardContent>
              <DealForm />
            </CardContent>
          </Card>
        </div>
      </Layout>
    </AuthGuard>
  );
}





