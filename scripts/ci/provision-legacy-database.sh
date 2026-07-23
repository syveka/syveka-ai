#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DIRECT_URL:?DIRECT_URL is required}"

legacy_sha="6f6ab84f0f3849a172e0fdfdc49610058640d56c"
legacy_dir="$(mktemp -d)"
trap 'rm -rf "$legacy_dir"' EXIT

git archive "$legacy_sha" \
  prisma/schema.prisma \
  prisma/sql/001_extensions_and_indexes.sql \
  prisma/sql/002_functions.sql \
  prisma/sql/003_rls.sql | tar -x -C "$legacy_dir"

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f tests/migrations/supabase-compatibility.sql
npx prisma db push --skip-generate --schema "$legacy_dir/prisma/schema.prisma"
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f "$legacy_dir/prisma/sql/001_extensions_and_indexes.sql"
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f "$legacy_dir/prisma/sql/002_functions.sql"
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f "$legacy_dir/prisma/sql/003_rls.sql"
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20260718000000_calendar_booking_rls/migration.sql
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f tests/migrations/legacy-extras.sql

published_migrations=(
  20260712000000_dashboard_indexes
  20260712120000_crm_contacts_companies_v1
  20260712180000_crm_deals_v1
  20260713000000_calendar_booking_v1
  20260714000000_secure_document_upload_intents
  20260715000000_ai_chat_production_hardening
  20260715230000_security_invariant_corrections
  20260718000000_calendar_booking_rls
)

for migration in "${published_migrations[@]}"; do
  npx prisma migrate resolve --applied "$migration"
done

applied_count="$(psql "$DIRECT_URL" -Atqc "select count(*) from public._prisma_migrations where finished_at is not null and rolled_back_at is null")"
if [ "$applied_count" != "8" ]; then
  echo "Expected exactly eight published legacy migrations, found $applied_count."
  exit 1
fi
