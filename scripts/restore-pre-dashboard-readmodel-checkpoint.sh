#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="$ROOT/backups/pre-dashboard-readmodel-2026-05-12"
BRANCH="checkpoint/pre-dashboard-readmodel-2026-05-12"
TAG="checkpoint/pre-dashboard-readmodel-2026-05-12"

cd "$ROOT"

if [[ ! -f "$BACKUP/db/local.db" ]]; then
  echo "Missing backup database: $BACKUP/db/local.db" >&2
  exit 1
fi

if [[ "${1:-}" != "--yes" ]]; then
  echo "This restores code, local.db, and .env.local to the pre-dashboard checkpoint."
  echo "Stop the dev server before continuing."
  echo "Re-run with: $0 --yes"
  exit 1
fi

git fetch --all --tags 2>/dev/null || true
if git show-ref --verify --quiet "refs/tags/$TAG"; then
  git checkout "$TAG"
elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
else
  echo "Checkpoint branch/tag not found: $BRANCH / $TAG" >&2
  exit 1
fi

cp "$BACKUP/db/local.db" "$ROOT/local.db"
rm -f "$ROOT/local.db-wal" "$ROOT/local.db-shm"

if [[ -f "$BACKUP/env/.env.local" ]]; then
  cp "$BACKUP/env/.env.local" "$ROOT/.env.local"
fi

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$ROOT/local.db" "PRAGMA integrity_check;"
fi

echo "Restored checkpoint: $BRANCH"
echo "Database: $BACKUP/db/local.db"
echo "Env: $BACKUP/env/.env.local"
