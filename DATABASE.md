# Database Schema Documentation

This document describes the database schema for the BDR Commission Tracking System.

## Overview

The system uses PostgreSQL via Supabase. All tables use UUID primary keys and include `created_at` and `updated_at` timestamps.

## Tables

### bdr_reps

Stores BDR representative information.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| id | UUID | PRIMARY KEY | Unique identifier |
| name | TEXT | NOT NULL | BDR name |
| email | TEXT | NOT NULL, UNIQUE | Email address (must match Supabase Auth email) |
| status | TEXT | NOT NULL, CHECK | 'active' or 'inactive' |
| created_at | TIMESTAMP | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last update timestamp |

### deals

Stores deal information.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| id | UUID | PRIMARY KEY | Unique identifier |
| bdr_id | UUID | NOT NULL, FK → bdr_reps | Assigned BDR rep |
| client_name | TEXT | NOT NULL | Client name |
| service_type | TEXT | NOT NULL | Service type (Tax, Monthly Accounting, etc.) |
| proposal_date | DATE | NOT NULL | Date proposal was sent |
| close_date | DATE | NULLABLE | Date deal was closed |
| first_invoice_date | DATE | NULLABLE | Date of first invoice (used for commission start) |
| deal_value | DECIMAL(12,2) | NOT NULL | Total deal value |
| status | TEXT | NOT NULL, CHECK | 'proposed', 'closed-won', or 'closed-lost' |
| is_renewal | BOOLEAN | DEFAULT false | Whether this is a renewal deal |
| original_deal_id | UUID | FK → deals | Original deal ID for renewals |
| cancellation_date | DATE | NULLABLE | Date deal was cancelled |
| payout_months | INTEGER | DEFAULT 12 | Number of months to spread commission |
| do_not_pay_future | BOOLEAN | DEFAULT false | Flag to stop future payments |
| created_at | TIMESTAMP | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last update timestamp |

**Indexes:**
- `idx_deals_bdr_id` on `bdr_id`
- `idx_deals_status` on `status`

### commission_entries

Stores individual commission payment entries.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| id | UUID | PRIMARY KEY | Unique identifier |
| deal_id | UUID | NOT NULL, FK → deals | Associated deal |
| bdr_id | UUID | NOT NULL, FK → bdr_reps | BDR rep receiving commission |
| month | DATE | NOT NULL | Month for this payment (first day of month) |
| amount | DECIMAL(12,2) | NOT NULL | Commission amount for this month |
| status | TEXT | NOT NULL, CHECK | 'pending', 'paid', or 'cancelled' |
| created_at | TIMESTAMP | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last update timestamp |

**Constraints:**
- UNIQUE(deal_id, month) - One entry per deal per month

**Indexes:**
- `idx_commission_entries_bdr_id` on `bdr_id`
- `idx_commission_entries_deal_id` on `deal_id`
- `idx_commission_entries_month` on `month`
- `idx_commission_entries_status` on `status`

### commission_rules

Stores commission calculation rules (singleton table).

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| id | UUID | PRIMARY KEY | Unique identifier |
| base_rate | DECIMAL(5,4) | DEFAULT 0.025 | Base commission rate (2.5%) |
| quarterly_bonus_rate | DECIMAL(5,4) | DEFAULT 0.025 | Quarterly bonus rate (2.5%) |
| renewal_rate | DECIMAL(5,4) | DEFAULT 0.01 | Renewal commission rate (1%) |
| payout_months_default | INTEGER | DEFAULT 12 | Default number of payout months |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last update timestamp |
| updated_by | UUID | FK → auth.users | User who last updated |

**Note:** Only one row should exist. New rules create a new row for historical tracking.

### quarterly_targets

Stores quarterly revenue targets for each BDR.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| id | UUID | PRIMARY KEY | Unique identifier |
| bdr_id | UUID | NOT NULL, FK → bdr_reps | BDR rep |
| quarter | TEXT | NOT NULL | Quarter in format 'YYYY-QN' (e.g., '2024-Q1') |
| target_revenue | DECIMAL(12,2) | NOT NULL | Target revenue for the quarter |
| created_at | TIMESTAMP | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last update timestamp |

**Constraints:**
- UNIQUE(bdr_id, quarter) - One target per BDR per quarter

**Indexes:**
- `idx_quarterly_targets_bdr_id` on `bdr_id`

### quarterly_performance

Stores quarterly performance data and bonus eligibility.

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| id | UUID | PRIMARY KEY | Unique identifier |
| bdr_id | UUID | NOT NULL, FK → bdr_reps | BDR rep |
| quarter | TEXT | NOT NULL | Quarter in format 'YYYY-QN' |
| revenue_collected | DECIMAL(12,2) | DEFAULT 0 | Revenue collected in quarter |
| achieved_percent | DECIMAL(5,2) | DEFAULT 0 | Percentage of target achieved |
| bonus_eligible | BOOLEAN | DEFAULT false | Whether bonus is eligible (100%+ target) |
| created_at | TIMESTAMP | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last update timestamp |

**Constraints:**
- UNIQUE(bdr_id, quarter) - One performance record per BDR per quarter

**Indexes:**
- `idx_quarterly_performance_bdr_id` on `bdr_id`

### service_pricing

Stores service-specific commission rates (optional overrides).

| Column | Type | Constraints | Description |
|--------|------|------------|-------------|
| id | UUID | PRIMARY KEY | Unique identifier |
| service_type | TEXT | NOT NULL, UNIQUE | Service type name |
| commission_percent | DECIMAL(5,4) | NULLABLE | Service-specific commission rate (null = use base_rate) |
| created_at | TIMESTAMP | DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMP | DEFAULT NOW() | Last update timestamp |

## Relationships

```
bdr_reps (1) ──< (many) deals
bdr_reps (1) ──< (many) commission_entries
bdr_reps (1) ──< (many) quarterly_targets
bdr_reps (1) ──< (many) quarterly_performance

deals (1) ──< (many) commission_entries
deals (1) ──< (many) deals (renewals via original_deal_id)

commission_rules (singleton)
service_pricing (many, optional)
```

## Database Functions

### calculate_quarterly_performance(bdr_id, quarter)

Calculates and updates quarterly performance metrics:
- Achieved percentage
- Bonus eligibility

### generate_commission_entries(deal_id)

Generates monthly commission entries for a closed-won deal:
- Calculates total commission
- Creates entries for each payout month
- Starts from first_invoice_date

### cancel_future_commission_entries(deal_id, cancellation_date)

Cancels all future (unpaid) commission entries for a deal.

## Triggers

### deal_closed_won_trigger

Automatically generates commission entries when a deal status changes to 'closed-won'.

### update_updated_at_column

Automatically updates `updated_at` timestamp on row updates for all tables.

## Row Level Security (RLS)

All tables have RLS enabled with the following policies:

### Admin Access
- Admins can view/edit all data
- Identified by `user_metadata.role = 'admin'`

### BDR Rep Access
- BDRs can only view/edit their own data
- Filtered by matching email in `bdr_reps` table

### Public Access
- Commission rules: Read-only for all authenticated users
- Service pricing: Read-only for all authenticated users

## Data Flow

1. **Deal Creation**: Deal created with status 'proposed'
2. **Deal Closed**: Status updated to 'closed-won', trigger generates commission entries
3. **Commission Entries**: Created monthly starting from first_invoice_date
4. **Payment**: Admin marks entries as 'paid'
5. **Cancellation**: Future entries marked as 'cancelled'

## Best Practices

1. Always set `first_invoice_date` when closing a deal
2. Use consistent quarter format: 'YYYY-QN'
3. Keep commission_rules table with single active row
4. Match BDR rep emails with Supabase Auth emails
5. Use transactions for multi-step operations

## Migration Files

- `001_initial_schema.sql`: Creates all tables, indexes, and triggers
- `002_rls_policies.sql`: Sets up Row Level Security policies
- `003_functions.sql`: Creates database functions and triggers





