#!/usr/bin/env bash
# scripts/migrate.sh — Apply all D1 migrations in order
#
# Usage:
#   ./scripts/migrate.sh staging   # Apply to staging D1 database
#   ./scripts/migrate.sh prod      # Apply to production D1 database
#
# Prerequisites: wrangler installed (npx wrangler) and CLOUDFLARE_API_TOKEN set.

set -euo pipefail

ENV="${1:-}"
if [[ -z "$ENV" ]]; then
  echo "Error: environment required (staging or prod)" >&2
  echo "Usage: $0 <staging|prod>" >&2
  exit 1
fi

case "$ENV" in
  staging) DB_NAME="webwaka-d1-staging" ;;
  prod)    DB_NAME="webwaka-d1-prod"    ;;
  *)
    echo "Error: unknown environment '$ENV'. Use 'staging' or 'prod'." >&2
    exit 1
    ;;
esac

MIGRATIONS_DIR="$(cd "$(dirname "$0")/../migrations" && pwd)"

echo "Applying migrations to D1 database: $DB_NAME ($ENV)"

for SQL_FILE in "$MIGRATIONS_DIR"/*.sql; do
  FILENAME="$(basename "$SQL_FILE")"
  echo "  → $FILENAME"
  npx wrangler d1 execute "$DB_NAME" \
    --file="$SQL_FILE" \
    --env="$ENV" \
    --remote
done

echo "All migrations applied successfully to $ENV."
