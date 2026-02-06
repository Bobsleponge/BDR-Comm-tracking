# Maintenance Guide

This guide covers common maintenance tasks and how to add new features to the BDR Commission Tracking System.

## Common Tasks

### Adding a New BDR Rep

1. Log in as admin
2. Go to Admin > Manage BDR Reps
3. Click "Add Rep"
4. Enter name and email
5. Create user account in Supabase Auth with matching email
6. User can now log in and access their dashboard

### Updating Commission Rules

1. Log in as admin
2. Go to Admin > Commission Rules
3. Update rates as needed
4. Click "Save Rules"
5. Note: Changes apply to new deals only (existing deals use rules at time of creation)

### Setting Quarterly Targets

1. Log in as admin
2. Go to Admin > Quarterly Targets
3. Select BDR rep
4. Enter quarter (format: YYYY-QN, e.g., 2024-Q1)
5. Enter target revenue
6. Click "Set Target"

### Entering Quarterly Revenue

1. Log in as admin
2. Go to Admin > Enter Quarterly Revenue
3. Select BDR rep
4. Enter quarter
5. Enter revenue collected
6. System automatically calculates:
   - Achieved percentage
   - Bonus eligibility

### Marking Commission as Paid

1. Log in as admin
2. Go to Commission page
3. Find commission entry
4. Click "Mark as Paid"
5. Entry status updates to 'paid'

### Cancelling a Deal

1. Navigate to deal detail page
2. Click "Cancel Deal"
3. Confirm cancellation
4. System automatically:
   - Marks future commission entries as cancelled
   - Updates deal cancellation_date

### Handling Rep Leave

1. Log in as admin
2. Go to Admin > Manage BDR Reps
3. Find the rep
4. Click "Deactivate"
5. System automatically:
   - Sets do_not_pay_future on all their deals
   - Cancels all future unpaid commission entries

## Adding New Commission Rules

The system is designed to be extensible. To add new commission rules:

### Option 1: Add to Existing Rules Table

1. Add new column to `commission_rules` table:
```sql
ALTER TABLE commission_rules
ADD COLUMN new_rule_rate DECIMAL(5,4);
```

2. Update TypeScript types in `types/database.ts`
3. Update `RulesEditor` component to include new field
4. Update commission calculation logic if needed

### Option 2: Service-Specific Rules

1. Add service type to `service_pricing` table:
```sql
INSERT INTO service_pricing (service_type, commission_percent)
VALUES ('New Service', 0.03);
```

2. System automatically uses service-specific rate when calculating commission

## Adding New Service Types

1. Update `SERVICE_TYPES` array in `components/deals/DealForm.tsx`
2. Optionally add service-specific pricing in `service_pricing` table

## Database Maintenance

### Backup

1. Use Supabase dashboard to create manual backup
2. Or use Supabase CLI:
```bash
supabase db dump > backup.sql
```

### Restore

1. Use Supabase SQL Editor to run backup SQL
2. Or use Supabase CLI:
```bash
supabase db reset
psql < backup.sql
```

### Performance Optimization

1. Monitor slow queries in Supabase dashboard
2. Add indexes as needed:
```sql
CREATE INDEX idx_table_column ON table(column);
```

3. Review and optimize RLS policies

## Updating Dependencies

1. Check for updates:
```bash
npm outdated
```

2. Update dependencies:
```bash
npm update
```

3. Test thoroughly after updates
4. Commit changes

## Adding New Features

### Adding a New Page

1. Create page in `app/` directory
2. Add route protection if needed:
```tsx
<AuthGuard>
  <Layout>
    {/* Page content */}
  </Layout>
</AuthGuard>
```

3. Add navigation link in `components/shared/Layout.tsx`

### Adding a New API Endpoint

1. Create route file in `app/api/`
2. Add authentication check:
```tsx
await requireAuth();
```

3. Add role check if admin-only:
```tsx
await requireAdmin();
```

4. Implement business logic
5. Return JSON response using `apiSuccess()` or `apiError()`

### Adding a New Calculation

1. Add function to `lib/commission/calculator.ts`
2. Add validation to `lib/commission/validators.ts` if needed
3. Update scheduler if automatic calculation needed
4. Update UI to display new calculation

## Troubleshooting

### Commission Not Calculating

1. Check deal status is 'closed-won'
2. Verify first_invoice_date is set
3. Check commission_rules table has data
4. Review database triggers in Supabase

### RLS Policy Blocking Access

1. Check user role in Supabase Auth metadata
2. Verify `is_admin()` function works correctly
3. Test query in Supabase SQL Editor
4. Review RLS policies in `002_rls_policies.sql`

### Performance Issues

1. Check database indexes
2. Review query patterns
3. Consider adding database functions for complex calculations
4. Monitor Supabase dashboard for slow queries

## Support

For issues or questions:
1. Check existing documentation
2. Review code comments
3. Check Supabase and Next.js documentation
4. Contact development team





