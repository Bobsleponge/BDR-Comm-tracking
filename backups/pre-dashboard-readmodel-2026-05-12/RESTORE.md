# Restore point: pre-dashboard read-model (2026-05-12)

## Active database at snapshot time

- Mode: local SQLite (`USE_LOCAL_DB=true` in `.env.local`)
- Live file: `local.db` in the project root (`LOCAL_DB_PATH` not set)
- Supabase: not configured (`NEXT_PUBLIC_SUPABASE_URL` unset)
- Row counts in backup DB: 334 commission entries, 113 deals, 4 commission batches

## What was saved

- `db/local.db` — consistent SQLite backup via `sqlite3 .backup` (on disk only; `local.db` is gitignored)
- `env/.env.local` — local env (gitignored; not in the git checkpoint)
- `reports/` and `artifacts/` — text reports and Excel workbooks
- Git branch `checkpoint/pre-dashboard-readmodel-2026-05-12` and tag `freeze/pre-dashboard-readmodel-2026-05-12`
- `MANIFEST.json` — checksum and row-count metadata
- `git-head.txt`, `git-branch.txt`, `git-status.txt` — metadata from snapshot time

## One-command restore (code + database + env)

Stop the dev server first, then:

```bash
cd "/Users/Matty/BDR Comm Tracking"
./scripts/restore-pre-dashboard-readmodel-checkpoint.sh --yes
```

## Restore code

```bash
cd "/Users/Matty/BDR Comm Tracking"
git checkout checkpoint/pre-dashboard-readmodel-2026-05-12
```

To return to `main` without losing this checkpoint, stay on the branch or merge later.

## Restore local database

Stop the dev server first, then:

```bash
cd "/Users/Matty/BDR Comm Tracking"
cp backups/pre-dashboard-readmodel-2026-05-12/db/local.db local.db
rm -f local.db-wal local.db-shm
```

Restart the app. Optional check:

```bash
sqlite3 local.db "PRAGMA integrity_check;"
```

## Restore env

```bash
cp backups/pre-dashboard-readmodel-2026-05-12/env/.env.local .env.local
```

## If you later use Supabase

This snapshot does not include cloud Postgres. Take a Supabase dashboard backup or `pg_dump` before production dashboard work.
