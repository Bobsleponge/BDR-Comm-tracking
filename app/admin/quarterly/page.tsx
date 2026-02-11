'use client';

import { AuthGuard } from '@/components/shared/AuthGuard';
import { RoleGuard } from '@/components/shared/RoleGuard';
import { Layout } from '@/components/shared/Layout';
import { RevenueEntryForm } from '@/components/admin/RevenueEntryForm';

export default function AdminQuarterlyPage() {
  return (
    <AuthGuard>
      <RoleGuard requiredRole="admin">
        <Layout>
          <div className="px-4 py-6 sm:px-0">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Enter Quarterly Revenue</h2>
            <RevenueEntryForm />
          </div>
        </Layout>
      </RoleGuard>
    </AuthGuard>
  );
}







