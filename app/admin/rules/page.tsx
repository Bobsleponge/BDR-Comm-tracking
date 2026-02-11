'use client';

import { AuthGuard } from '@/components/shared/AuthGuard';
import { RoleGuard } from '@/components/shared/RoleGuard';
import { Layout } from '@/components/shared/Layout';
import { RulesEditor } from '@/components/admin/RulesEditor';

export default function AdminRulesPage() {
  return (
    <AuthGuard>
      <RoleGuard requiredRole="admin">
        <Layout>
          <div className="px-4 py-6 sm:px-0">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Commission Rules</h2>
            <RulesEditor />
          </div>
        </Layout>
      </RoleGuard>
    </AuthGuard>
  );
}







