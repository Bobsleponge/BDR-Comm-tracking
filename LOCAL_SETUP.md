# Local Development Setup

The app is now configured to work with a local SQLite database - no Docker or Supabase required!

## Quick Start

1. **Database is already initialized** - The `local.db` file has been created with all tables.

2. **Test Users Created:**
   - **Admin**: `admin@example.com` (password: any)
   - **BDR**: `test@example.com` (password: any)

3. **Start the app:**
   ```bash
   npm run dev
   ```

4. **Login:**
   - Go to http://localhost:3000
   - Use either test email (password can be anything for local dev)
   - Admin email gives you admin access

## How It Works

- Uses SQLite database (`local.db` file)
- Simple session-based authentication (no Supabase needed)
- All data stored locally
- Fully functional for development

## Adding More Users

To add more BDR reps, you can:

1. **Via the app** (after logging in as admin):
   - Go to Admin > Manage BDR Reps
   - Add new rep

2. **Via script:**
   ```bash
   npx tsx scripts/init-local-db.ts
   ```

## Database Location

- Database file: `local.db` (in project root)
- You can view/edit it with any SQLite browser
- Database is automatically initialized on first use

## Switching Back to Supabase

To use Supabase instead:
1. Set `USE_LOCAL_DB=false` in environment
2. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. Restart the app

## Notes

- Passwords are ignored in local mode (any password works)
- Sessions last 7 days
- All data persists in `local.db` file
- Database is gitignored (won't be committed)




