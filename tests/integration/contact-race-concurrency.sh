#!/usr/bin/env bash
# Real-Postgres proof for the duplicate-Contact race fixed in
# src/server/services/booking.ts / src/server/calendar/locks.ts
# (lockContactEmail). Found during PR #91 review: lockOwnerCalendar's
# advisory lock is keyed on (orgId, ownerId), so two concurrent public
# bookings for the SAME new guest email but DIFFERENT booking types
# (different owners) within the same org are never serialized against each
# other by that lock alone - a bare find-then-create Contact block can then
# commit two rows for the same (org, email). Not wired into CI (see
# booking-concurrency.sh's identical note) - manual/local verification:
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/contact-race-concurrency.sh
#
# Uses a minimal throwaway table, same reasoning as booking-concurrency.sh:
# the race is a property of Postgres's READ COMMITTED isolation model, not
# of the contacts table's specific columns/FKs.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance, e.g. postgresql://postgres:postgres@localhost:5432/postgres}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop table if exists _contact_race_repro;
create table _contact_race_repro (
  id serial primary key,
  org_id text not null,
  owner_id text not null,
  email text not null
);
SQL

# Each session simulates one booking's Contact find-then-create block, for a
# DIFFERENT owner_id (different booking type) but the SAME org+email - the
# exact scenario lockOwnerCalendar's per-owner key does not serialize.
# $1: owner id to use.  $2: "true"/"false" - whether to take lockContactEmail first (the fix).
run_session() {
  local owner_id="$1"
  local take_lock="$2"
  local lock_stmt=""
  if [ "$take_lock" = "true" ]; then
    lock_stmt="select pg_advisory_xact_lock(hashtext('org-a' || ':' || 'guest@example.test'), 1);"
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
begin;
$lock_stmt
select pg_sleep(1);
do \$\$
begin
  if not exists (
    select 1 from _contact_race_repro
    where org_id = 'org-a' and email = 'guest@example.test'
  ) then
    insert into _contact_race_repro (org_id, owner_id, email)
    values ('org-a', '$owner_id', 'guest@example.test');
  end if;
end \$\$;
commit;
SQL
}

echo "=== Scenario 1: WITHOUT lockContactEmail (pre-fix behavior) ==="
run_session "owner-A" "false" &
pid1=$!
run_session "owner-B" "false" &
pid2=$!
wait "$pid1" "$pid2" || true

without_lock_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _contact_race_repro where org_id = 'org-a' and email = 'guest@example.test'")
echo "Contact rows for the same new email, different booking types, without the lock: $without_lock_count"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "delete from _contact_race_repro where org_id = 'org-a'"

echo "=== Scenario 2: WITH lockContactEmail (post-fix behavior) ==="
run_session "owner-A" "true" &
pid1=$!
run_session "owner-B" "true" &
pid2=$!
wait "$pid1" "$pid2" || true

with_lock_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _contact_race_repro where org_id = 'org-a' and email = 'guest@example.test'")
echo "Contact rows for the same new email, different booking types, with the lock: $with_lock_count"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "drop table _contact_race_repro"

echo
if [ "$without_lock_count" -eq 2 ] && [ "$with_lock_count" -eq 1 ]; then
  echo "PROVEN: without lockContactEmail both concurrent transactions committed a"
  echo "Contact row each (duplicate); with it only one did (the second correctly"
  echo "saw the first's committed row after acquiring the lock)."
  exit 0
else
  echo "UNEXPECTED RESULT: without_lock=$without_lock_count (want 2), with_lock=$with_lock_count (want 1)"
  exit 1
fi
