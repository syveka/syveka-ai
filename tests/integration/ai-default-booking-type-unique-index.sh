#!/usr/bin/env bash
# Real-Postgres proof for the database-level invariant added in
# prisma/migrations/20260823010000_booking_types_ai_default_unique_index
# (a partial unique index: at most one BookingType per organization may
# have is_ai_booking_default = true). Not wired into CI - see
# tests/integration/booking-concurrency.sh's header for why. Run against
# any scratch Postgres:
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/ai-default-booking-type-unique-index.sh
#
# Three things are proven, each against the REAL migration.sql file (not a
# hand-copied variant):
#   1. A raw, direct SQL write - bypassing the application entirely, the
#      same as a future script/admin tool/migration/Prisma Studio edit
#      would - cannot create a second AI-default BookingType for one
#      organization. The database itself refuses it, not just app code.
#   2. Two DIFFERENT organizations can each freely have their own default -
#      the constraint is correctly scoped per-organization, not global.
#   3. saveBookingType's actual "switch the default" statement sequence
#      (clear the old default, THEN claim the new one - see
#      src/server/services/booking.ts) succeeds cleanly against the index.
#      The ORIGINAL order (claim new true, then clear old) was proven to
#      fail against this same index during development - this script
#      proves the FIXED order the shipped code actually uses.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance, e.g. postgresql://postgres:postgres@localhost:5432/postgres}"
MIGRATION_SQL="$(dirname "$0")/../../prisma/migrations/20260823010000_booking_types_ai_default_unique_index/migration.sql"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop table if exists booking_types cascade;
create extension if not exists pgcrypto;
create table booking_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  is_ai_booking_default boolean not null default false
);
SQL

echo "=== Applying the REAL migration file against a clean table ==="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$MIGRATION_SQL"
echo "Migration applied cleanly."

echo "=== Test 1: a raw direct SQL write cannot create a second default for the same org ==="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "insert into booking_types (organization_id, is_ai_booking_default) values ('11111111-1111-1111-1111-111111111111', true)"
set +e
direct_write_output=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "insert into booking_types (organization_id, is_ai_booking_default) values ('11111111-1111-1111-1111-111111111111', true)" 2>&1)
direct_write_exit=$?
set -e
echo "$direct_write_output"
echo "Second direct INSERT exit code: $direct_write_exit (want non-zero)"

echo "=== Test 2: a DIFFERENT organization can freely have its own default ==="
set +e
other_org_output=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "insert into booking_types (organization_id, is_ai_booking_default) values ('22222222-2222-2222-2222-222222222222', true)" 2>&1)
other_org_exit=$?
set -e
echo "$other_org_output"
echo "Different-org INSERT exit code: $other_org_exit (want 0)"

echo "=== Test 3: saveBookingType's actual statement order (clear old, THEN claim new) succeeds ==="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "insert into booking_types (id, organization_id, is_ai_booking_default) values ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', false)"
set +e
switch_output=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' 2>&1
begin;
-- Mirrors saveBookingType: clear every OTHER true row for this org first...
update booking_types
  set is_ai_booking_default = false
  where organization_id = '11111111-1111-1111-1111-111111111111'
    and is_ai_booking_default = true
    and id <> 'bbbbbbbb-0000-0000-0000-000000000002';
-- ...THEN claim the new one.
update booking_types
  set is_ai_booking_default = true
  where id = 'bbbbbbbb-0000-0000-0000-000000000002';
commit;
SQL
)
switch_exit=$?
set -e
echo "$switch_output"
echo "Switch (clear-then-claim) exit code: $switch_exit (want 0)"

final_true_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from booking_types where organization_id = '11111111-1111-1111-1111-111111111111' and is_ai_booking_default = true")
final_true_id=$(psql "$DATABASE_URL" -tAq -c \
  "select id from booking_types where organization_id = '11111111-1111-1111-1111-111111111111' and is_ai_booking_default = true")

echo "=== Test 4: the advisory lock AND the index working together under real concurrency ==="
echo "    (two concurrent 'switch the default' attempts, each using the app's actual"
echo "     lock + clear-then-claim order, against a table THAT HAS the unique index)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "delete from booking_types where organization_id = '11111111-1111-1111-1111-111111111111'"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "insert into booking_types (id, organization_id, is_ai_booking_default) values ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', true), ('cccccccc-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', false), ('cccccccc-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', false)"

# $1: BookingType id this session switches the org's default TO.
run_switch() {
  local target_id="$1"
  psql "$DATABASE_URL" -tAq <<SQL 2>&1
begin;
select pg_advisory_xact_lock(hashtext('11111111-1111-1111-1111-111111111111'), 2);
select pg_sleep(0.3);
update booking_types
  set is_ai_booking_default = false
  where organization_id = '11111111-1111-1111-1111-111111111111'
    and is_ai_booking_default = true
    and id <> '$target_id';
update booking_types
  set is_ai_booking_default = true
  where id = '$target_id';
commit;
select 'ok';
SQL
}

run_switch "cccccccc-0000-0000-0000-000000000002" > /tmp/_switch_1.out 2>&1 &
pid1=$!
run_switch "cccccccc-0000-0000-0000-000000000003" > /tmp/_switch_2.out 2>&1 &
pid2=$!
wait "$pid1"
wait "$pid2"

switch1_ok=$(grep -c "^ok$" /tmp/_switch_1.out || true)
switch2_ok=$(grep -c "^ok$" /tmp/_switch_2.out || true)
switch1_violation=$(grep -c "duplicate key value" /tmp/_switch_1.out || true)
switch2_violation=$(grep -c "duplicate key value" /tmp/_switch_2.out || true)
cat /tmp/_switch_1.out /tmp/_switch_2.out
rm -f /tmp/_switch_1.out /tmp/_switch_2.out

concurrent_true_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from booking_types where organization_id = '11111111-1111-1111-1111-111111111111' and is_ai_booking_default = true")

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "drop table booking_types cascade"

echo
if [ "$direct_write_exit" -ne 0 ] \
  && echo "$direct_write_output" | grep -q "booking_types_organization_id_is_ai_booking_default_key" \
  && [ "$other_org_exit" -eq 0 ] \
  && [ "$switch_exit" -eq 0 ] \
  && [ "$final_true_count" -eq 1 ] \
  && [ "$final_true_id" = "bbbbbbbb-0000-0000-0000-000000000002" ] \
  && [ "$switch1_ok" -eq 1 ] && [ "$switch2_ok" -eq 1 ] \
  && [ "$switch1_violation" -eq 0 ] && [ "$switch2_violation" -eq 0 ] \
  && [ "$concurrent_true_count" -eq 1 ]; then
  echo "PROVEN:"
  echo "  1. A raw direct SQL write attempting a second AI-default for one org was rejected"
  echo "     by the database itself (unique constraint violation), regardless of application code."
  echo "  2. A different organization's own default was accepted without any interference."
  echo "  3. The application's actual clear-then-claim statement order switches the default"
  echo "     cleanly with the index in place - exactly one true row, the newly-claimed one."
  echo "  4. Two CONCURRENT switch attempts, each using the real lock + clear-then-claim order,"
  echo "     against a table WITH the unique index: both completed successfully, NEITHER ever hit"
  echo "     a constraint violation (the lock serializes them before either could), and exactly"
  echo "     one row ended up true - the advisory lock and the DB constraint work together, not"
  echo "     against each other."
  exit 0
else
  echo "UNEXPECTED RESULT: direct_write_exit=$direct_write_exit (want !=0), other_org_exit=$other_org_exit (want 0), switch_exit=$switch_exit (want 0), final_true_count=$final_true_count (want 1), final_true_id=$final_true_id (want bbbbbbbb-0000-0000-0000-000000000002), switch1_ok=$switch1_ok switch2_ok=$switch2_ok (want 1 1), switch1_violation=$switch1_violation switch2_violation=$switch2_violation (want 0 0), concurrent_true_count=$concurrent_true_count (want 1)"
  exit 1
fi
