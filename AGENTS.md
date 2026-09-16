# AGENTS.md

## Cursor Cloud specific instructions

This is a **Next.js 15 (App Router)** commission-tracking web app. By default it runs in **local SQLite mode** (no Supabase needed): when `NEXT_PUBLIC_SUPABASE_URL` is unset, all data goes to a `local.db` file created automatically in the repo root on first request. See `README.md`, `LOCAL_SETUP.md`, and `DATABASE.md` for domain details.

### Dependencies
- Install with `npm install --legacy-peer-deps`. The `--legacy-peer-deps` flag is **required**: `@tremor/react` declares a React 18 peer dependency while the app uses React 19, so a plain `npm install`/`npm ci` fails with `ERESOLVE`. The update script already handles this.
- `better-sqlite3` is a native module; it is rebuilt during install.

### Run / build / test / lint (see `package.json` scripts)
- Dev server: `npm run dev` (Next.js on `0.0.0.0:3000`). The `dev` script first runs `scripts/show-local-ip.js`, which just prints the LAN IP — harmless.
- Tests: `npm test` (Vitest, `vitest run` for one-shot). Only `lib/commission` has unit tests currently.
- Lint: `npm run lint` (`next lint`; a pre-existing `react-hooks/exhaustive-deps` warning in `app/clients/[id]/page.tsx` is expected).
- Production build/start: `npm run build` / `npm start`.

### Auth in local mode
- No real passwords: any password works. Sign in via the login page or `POST /api/auth/signin` with `{ "email", "password" }`.
- Seeded/known accounts: `admin@example.com` (admin) and `test@example.com` (BDR). The admin role is granted to the `admin@example.com` email. New emails can be created via signup.
- Session is a `local_session` httpOnly cookie (7-day expiry).

### Notes
- The DB file (`local.db`) is gitignored and recreated automatically; to reseed base test users run `npx tsx scripts/init-local-db.ts`.
- Switch to Supabase mode by setting `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (and running the SQL migrations in `supabase/migrations/`); otherwise local mode is used.
