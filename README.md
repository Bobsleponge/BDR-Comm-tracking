# BDR Commission Tracking System

A comprehensive commission tracking application for BDR (Business Development Representative) teams. This system helps track deals, calculate commissions, manage quarterly bonuses, and handle commission payouts.

## Features

- **Multi-Rep Support**: Track commissions for multiple BDR representatives
- **Deal Management**: Create, update, and track deals through their lifecycle
- **Commission Calculation**: Automatic commission calculation based on configurable rules
- **Quarterly Bonuses**: Track quarterly performance and calculate bonus eligibility
- **Payout Scheduling**: Monthly commission payouts over 12 months (configurable)
- **Admin Panel**: Manage BDR reps, commission rules, and quarterly targets
- **Commission Forecasting**: 12-month forecast of expected commission payouts
- **CSV Export**: Export deals and commission data to CSV
- **Overdue Tracking**: Highlight overdue commission payments

## Tech Stack

- **Frontend**: Next.js 14 (App Router) with React Server Components
- **Backend**: Supabase (PostgreSQL + Auth + Realtime)
- **Styling**: Tailwind CSS
- **Deployment**: Vercel (frontend) + Supabase (backend)

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- (Optional) Supabase account for production deployment
- (Optional) Vercel account for deployment

### Local Development Mode (Default)

The application defaults to **local development mode** using SQLite when Supabase environment variables are not set. This makes it easy to get started without any external dependencies.

1. Clone the repository:
```bash
git clone <repository-url>
cd "BDR Comm Tracking"
```

2. Install dependencies:
```bash
npm install
```

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

5. Login with test accounts:
   - **Admin**: `admin@example.com` (any password)
   - **BDR**: `test@example.com` (any password)

The database (`local.db`) will be automatically created on first run. See [LOCAL_SETUP.md](LOCAL_SETUP.md) for more details.

### Docker (When Local Dev Fails)

If the app doesn't launch properly with `npm run dev`, use Docker:

1. Start Docker Desktop
2. Run: `docker compose up --build -d`
3. Open [http://localhost:3000](http://localhost:3000)

See [DOCKER.md](DOCKER.md) for full instructions.

### Supabase Mode (Production)

To use Supabase instead of local SQLite:

1. Set up environment variables:
```bash
cp .env.local.example .env.local
```

Edit `.env.local` and add your Supabase credentials:
```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

2. Set up the database:
   - Create a new Supabase project
   - Run the migration files in `supabase/migrations/` in order:
     - `001_initial_schema.sql`
     - `002_rls_policies.sql`
     - `003_functions.sql`

3. Run the development server:
```bash
npm run dev
```

The app will automatically detect Supabase credentials and use Supabase mode instead of local mode.

## Project Structure

```
/
├── app/                    # Next.js app router pages
│   ├── api/               # API routes
│   ├── admin/              # Admin pages
│   ├── dashboard/          # BDR dashboard
│   ├── deals/              # Deal management
│   ├── commission/         # Commission tracking
│   └── login/              # Authentication
├── components/             # React components
│   ├── admin/              # Admin components
│   ├── commission/         # Commission components
│   ├── dashboard/          # Dashboard components
│   ├── deals/              # Deal components
│   └── shared/             # Shared components
├── lib/                    # Utility libraries
│   ├── commission/         # Commission calculation engine
│   ├── supabase/           # Supabase client utilities
│   └── utils/              # Helper functions
├── supabase/               # Database migrations
│   └── migrations/         # SQL migration files
└── types/                  # TypeScript type definitions
```

## Commission Structure

### Base Commission
- Default: 2.5% of deal value
- Paid immediately when deal is closed-won
- Spread over 12 months (configurable)

### Quarterly Bonus
- Default: Additional 2.5% of revenue collected
- Only eligible if quarterly target is met (100%+)
- Calculated on revenue collected, not deal value

### Renewals
- Treated as new deals
- Same commission structure as new deals
- Count toward quarterly targets

### Cancellations
- Future unpaid months are cancelled
- Past unpaid months remain pending

## User Roles

### Admin
- Manage BDR reps
- Edit commission rules
- Set quarterly targets
- Enter quarterly revenue
- Mark commission entries as paid
- View all deals and commissions

### BDR Rep
- View own deals and commissions
- Create and update own deals
- View commission forecast
- Track quarterly progress

## Documentation

- [Deployment Guide](DEPLOYMENT.md)
- [Maintenance Guide](MAINTENANCE.md)
- [API Documentation](API.md)
- [Database Schema](DATABASE.md)

## License

Proprietary - All rights reserved




