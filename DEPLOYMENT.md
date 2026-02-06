# Deployment Guide

This guide walks you through deploying the BDR Commission Tracking System to production.

## Prerequisites

- Supabase account
- Vercel account
- GitHub account (recommended)

## Step 1: Set Up Supabase

1. Create a new Supabase project at [supabase.com](https://supabase.com)
2. Note your project URL and anon key from Settings > API
3. Run the database migrations:
   - Go to SQL Editor in Supabase
   - Run `supabase/migrations/001_initial_schema.sql`
   - Run `supabase/migrations/002_rls_policies.sql`
   - Run `supabase/migrations/003_functions.sql`

4. Set up authentication:
   - Go to Authentication > Settings
   - Enable Email provider
   - Configure email templates if needed

5. Set up admin users:
   - Create admin users via Supabase Auth
   - Update user metadata to set `role: 'admin'`:
   ```sql
   UPDATE auth.users
   SET raw_user_meta_data = jsonb_build_object('role', 'admin')
   WHERE email = 'admin@example.com';
   ```

## Step 2: Deploy to Vercel

1. Push your code to GitHub:
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-github-repo>
git push -u origin main
```

2. Import project to Vercel:
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project"
   - Import your GitHub repository
   - Configure project settings

3. Add environment variables in Vercel:
   - Go to Project Settings > Environment Variables
   - Add:
     - `NEXT_PUBLIC_SUPABASE_URL`: Your Supabase project URL
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Your Supabase anon key

4. Deploy:
   - Vercel will automatically deploy on push to main
   - Or click "Deploy" manually

## Step 3: Configure Supabase RLS

1. Update the `is_admin` function in Supabase to match your admin identification method
2. Test RLS policies by logging in as both admin and BDR users

## Step 4: Initial Setup

1. Log in as admin
2. Create BDR rep records:
   - Go to Admin > Manage BDR Reps
   - Add each BDR rep with their email
   - Ensure email matches their Supabase Auth email

3. Set up commission rules:
   - Go to Admin > Commission Rules
   - Review and adjust default rates if needed

4. Set quarterly targets:
   - Go to Admin > Quarterly Targets
   - Set targets for each BDR for the current quarter

## Step 5: Create Initial Users

1. In Supabase Auth, create user accounts for each BDR
2. Ensure email matches the BDR rep record
3. Set admin role for admin users (see Step 1)

## Post-Deployment Checklist

- [ ] Database migrations applied
- [ ] Environment variables configured
- [ ] Admin users created with correct role
- [ ] BDR rep records created
- [ ] Commission rules configured
- [ ] Quarterly targets set
- [ ] Test login as admin
- [ ] Test login as BDR rep
- [ ] Test deal creation
- [ ] Test commission calculation
- [ ] Verify RLS policies working correctly

## Troubleshooting

### Authentication Issues
- Verify Supabase URL and keys are correct
- Check that users exist in Supabase Auth
- Ensure email matches between Auth and bdr_reps table

### RLS Policy Issues
- Check that `is_admin` function works correctly
- Verify user metadata has correct role
- Test policies in Supabase SQL editor

### Commission Not Calculating
- Ensure deal status is 'closed-won'
- Verify first_invoice_date is set
- Check commission_rules table has data
- Review database triggers are active

## Monitoring

- Monitor Supabase dashboard for database performance
- Check Vercel analytics for frontend performance
- Set up error tracking (e.g., Sentry) for production errors

## Backup Strategy

1. Enable Supabase daily backups
2. Export database schema regularly
3. Keep migration files in version control





