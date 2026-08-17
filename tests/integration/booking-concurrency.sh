#!/usr/bin/env bash
# Real-Postgres proof for the double-booking race fixed in
# src/server/services/booking.ts (lockOwnerCalendarForBooking). Not wired into
# CI (the "Unit and integration tests" job has no live Postgres - see that
# job's definition in .github/workflows/ci.yml), so this is a manual/local
# verification tool, not part of `npm test`. Run against any scratch Postgres:
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/booking-concurrency.sh
#
# It does NOT touch the real calendar_events/bookings tables or their FK
# graph - the check-then-insert-under-READ-COMMITTED race being proven here is
# a property of Postgres's isolation model, not of those tables' specific
# columns, so a minimal throwaway table reproduces the exact same mechanism
# lockOwnerCalendarForBooking() relies on (pg_advisory_xact_lock serializing
# concurrent transactions) without needing the full organizations/users FK
# graph. A *_real (temp) table cannot be used here: temp tables are
# per-session, and this test needs two separate psql connections to see the
# same table.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance, e.g. postgresql://postgres:postgres@localhost:5432/postgres}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop table if exists _booking_concurrency_repro;
create table _booking_concurrency_repro (
  id serial primary key,
  owner_id text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null
);
SQL

# Each session: re-checks for an overlapping row (mirrors assertSlotStillFree),
# sleeps 1s to force the two sessions' checks to overlap in real time (without
# this, a fast local run might not hit the race window), then inserts if clear.
# $1: "true"/"false" - whether to take the advisory lock first (the fix).
run_session() {
  local take_lock="$1"
  local lock_stmt=""
  if [ "$take_lock" = "true" ]; then
    lock_stmt="select pg_advisory_xact_lock(hashtext('org-a'), hashtext('owner-1'));"
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
begin;
$lock_stmt
select pg_sleep(1);
do \$\$
begin
  if exists (
    select 1 from _booking_concurrency_repro
    where owner_id = 'owner-1'
      and starts_at < '2026-06-01T10:00:00Z'::timestamptz
      and ends_at   > '2026-06-01T09:00:00Z'::timestamptz
  ) then
    raise exception 'slot_taken';
  end if;
end \$\$;
insert into _booking_concurrency_repro (owner_id, starts_at, ends_at)
values ('owner-1', '2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z');
commit;
SQL
}

echo "=== Scenario 1: WITHOUT the advisory lock (pre-fix behavior) ==="
run_session "false" &
pid1=$!
run_session "false" &
pid2=$!
wait "$pid1" "$pid2" || true

without_lock_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _booking_concurrency_repro where owner_id = 'owner-1'")
echo "Rows inserted for the same slot without the lock: $without_lock_count"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "delete from _booking_concurrency_repro where owner_id = 'owner-1'"

echo "=== Scenario 2: WITH the advisory lock (post-fix behavior) ==="
run_session "true" &
pid1=$!
run_session "true" &
pid2=$!
wait "$pid1" "$pid2" || true

with_lock_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _booking_concurrency_repro where owner_id = 'owner-1'")
echo "Rows inserted for the same slot with the lock: $with_lock_count"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "drop table _booking_concurrency_repro"

echo
if [ "$without_lock_count" -eq 2 ] && [ "$with_lock_count" -eq 1 ]; then
  echo "PROVEN: without the lock both concurrent transactions committed (double-booked);"
  echo "with the lock only one did (the second correctly saw the first's committed row)."
  exit 0
else
  echo "UNEXPECTED RESULT: without_lock=$without_lock_count (want 2), with_lock=$with_lock_count (want 1)"
  exit 1
fi
