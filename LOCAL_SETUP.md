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
   - Go to http://localhost:3001
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

## Optional: AI note interpretation (Import Boss Update)

Free-form boss notes in imported reports are interpreted via OpenAI when `OPENAI_API_KEY` is set in `.env.local` (Next.js loads this automatically on dev start).

```bash
OPENAI_API_KEY=sk-...
# Optional: defaults to gpt-4o-mini
OPENAI_MODEL=gpt-4o-mini
```

Without `OPENAI_API_KEY`, structured column diffs still work; free-form notes are flagged for manual review.

**After adding or changing `.env.local`, restart the dev server** (`npm run dev`).

- Sessions last 7 days
- All data persists in `local.db` file
- Database is gitignored (won't be committed)




