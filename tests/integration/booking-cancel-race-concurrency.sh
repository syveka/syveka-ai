#!/usr/bin/env bash
# Real-Postgres proof for the duplicate-side-effect race fixed in
# src/server/services/booking.ts's cancelBookingCore (and the identical
# pattern applied to rescheduleBookingViaToken's own booking-update).
# Found during PR #92 adversarial review: cancelBookingAsOwner (owner-
# authenticated calendar cancel) has no token to consume, so it never
# participates in cancelBookingViaToken's consumeTokenAtomic guard - the
# only thing that had ever serialized concurrent booking-status writes.
# cancelBookingCore's own booking-status write was a blind
# `UPDATE ... WHERE id = X`, so two concurrent cancelers (owner vs owner,
# or owner vs a guest's token-cancel) could both pass a pre-write status
# check and both apply every side effect (duplicate CRM Activity row,
# duplicate booking.canceled workflow event, duplicate notification
# attempt) instead of one succeeding and one cleanly rejecting. Not wired
# into CI (see booking-concurrency.sh's identical note) - manual/local
# verification:
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/booking-cancel-race-concurrency.sh
#
# Uses a minimal throwaway table, same reasoning as booking-concurrency.sh:
# the race is a property of Postgres's READ COMMITTED isolation model and
# row-locking on UPDATE, not of the bookings table's specific columns/FKs -
# a plain "SELECT then blind UPDATE" vs. a "SELECT then guarded
# conditional UPDATE" reproduces the exact same mechanism
# cancelBookingCore relies on.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance, e.g. postgresql://postgres:postgres@localhost:5432/postgres}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop table if exists _booking_cancel_race_repro;
create table _booking_cancel_race_repro (
  id text primary key,
  status text not null default 'CONFIRMED',
  side_effect_count int not null default 0
);
insert into _booking_cancel_race_repro (id) values ('bk-race-1');
SQL

# Each session simulates one caller's cancelBookingCore critical section.
# $1: "blind" (the old, unguarded pattern) or "guarded" (the fix).
run_session() {
  local mode="$1"
  local update_clause
  if [ "$mode" = "guarded" ]; then
    update_clause="update _booking_cancel_race_repro set status = 'CANCELED' where id = 'bk-race-1' and status not in ('CANCELED','RESCHEDULED');"
  else
    update_clause="update _booking_cancel_race_repro set status = 'CANCELED' where id = 'bk-race-1';"
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
begin;
select status from _booking_cancel_race_repro where id = 'bk-race-1';
select pg_sleep(1);
do \$\$
declare affected int;
begin
  $update_clause
  get diagnostics affected = row_count;
  if affected > 0 then
    update _booking_cancel_race_repro set side_effect_count = side_effect_count + 1 where id = 'bk-race-1';
  end if;
end \$\$;
commit;
SQL
}

echo "=== Scenario 1: WITHOUT the guard (pre-fix cancelBookingCore behavior) ==="
run_session "blind" &
pid1=$!
run_session "blind" &
pid2=$!
wait "$pid1" "$pid2" || true

without_guard_count=$(psql "$DATABASE_URL" -tAq -c \
  "select side_effect_count from _booking_cancel_race_repro where id = 'bk-race-1'")
echo "Side-effect applications (e.g. duplicate Activity rows) without the guard: $without_guard_count"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "update _booking_cancel_race_repro set status = 'CONFIRMED', side_effect_count = 0 where id = 'bk-race-1'"

echo "=== Scenario 2: WITH the guard (cancelBookingCore's fixed updateMany) ==="
run_session "guarded" &
pid1=$!
run_session "guarded" &
pid2=$!
wait "$pid1" "$pid2" || true

with_guard_count=$(psql "$DATABASE_URL" -tAq -c \
  "select side_effect_count from _booking_cancel_race_repro where id = 'bk-race-1'")
echo "Side-effect applications with the guard: $with_guard_count"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "drop table _booking_cancel_race_repro"

echo
if [ "$without_guard_count" -eq 2 ] && [ "$with_guard_count" -eq 1 ]; then
  echo "PROVEN: without the guard both concurrent cancelers applied their side effects"
  echo "(duplicate); with the guard, the second caller's conditional UPDATE matched zero"
  echo "rows once the first had committed, so only one application occurred."
  exit 0
else
  echo "UNEXPECTED RESULT: without_guard=$without_guard_count (want 2), with_guard=$with_guard_count (want 1)"
  exit 1
fi
