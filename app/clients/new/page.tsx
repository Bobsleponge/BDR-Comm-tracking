'use client';

import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { ClientForm } from '@/components/clients/ClientForm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function NewClientPage() {
  return (
    <AuthGuard>
      <Layout>
        <div className="px-4 py-6 sm:px-0">
          <h2 className="text-2xl font-bold mb-6">New Client</h2>
          <Card>
            <CardHeader>
              <CardTitle>Client Information</CardTitle>
            </CardHeader>
            <CardContent>
              <ClientForm />
            </CardContent>
          </Card>
        </div>
      </Layout>
    </AuthGuard>
  );
}



