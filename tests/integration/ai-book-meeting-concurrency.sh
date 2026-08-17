#!/usr/bin/env bash
# Real-Postgres proof for the AI bookMeeting concurrency race fixed via
# lockOrgCalendar() (src/server/calendar/locks.ts). Not wired into CI (the
# "Unit and integration tests" job has no live Postgres - see that job's
# definition in .github/workflows/ci.yml), so this is a manual/local
# verification tool, not part of `npm test`. Run against any scratch Postgres:
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/ai-book-meeting-concurrency.sh
#
# It does NOT touch the real calendar_events table or its FK graph - see
# tests/integration/booking-concurrency.sh for why a minimal throwaway table
# faithfully reproduces this mechanism without needing the full
# organizations/users FK graph.
#
# Unlike booking-concurrency.sh (which relies on a fixed pg_sleep to widen the
# race window - reliable but occasionally missed the race under process-launch
# jitter, per PR #80's review), this version uses a real synchronization
# barrier: both sessions signal readiness with an autocommit UPDATE (visible
# across connections immediately, unlike an uncommitted transaction's own
# writes) and then busy-poll until BOTH have signaled before either enters its
# race-critical transaction. This absorbs all connection/startup timing
# variance instead of merely outlasting it, so both scenarios below are
# expected to be deterministic on every run.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance, e.g. postgresql://postgres:postgres@localhost:5432/postgres}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop table if exists _bookmeeting_concurrency_repro;
create table _bookmeeting_concurrency_repro (
  id serial primary key,
  org_id text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null
);
drop table if exists _bookmeeting_concurrency_barrier;
create table _bookmeeting_concurrency_barrier (id int primary key, ready int not null default 0);
SQL

reset_barrier() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "delete from _bookmeeting_concurrency_barrier; insert into _bookmeeting_concurrency_barrier values (1, 0);"
}

# $1: "true"/"false" - whether to take the advisory lock first (the fix).
run_session() {
  local take_lock="$1"
  local lock_stmt=""
  if [ "$take_lock" = "true" ]; then
    lock_stmt="select pg_advisory_xact_lock(hashtext('org-a'));"
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
-- Signal readiness (autocommit, immediately visible to the other session -
-- an uncommitted transaction's own writes would not be) then busy-wait until
-- both sessions have signaled, so neither enters the race-critical section
-- until they can do so at effectively the same instant.
update _bookmeeting_concurrency_barrier set ready = ready + 1 where id = 1;
do \$\$
begin
  while (select ready from _bookmeeting_concurrency_barrier where id = 1) < 2 loop
    perform pg_sleep(0.005);
  end loop;
end \$\$;

begin;
$lock_stmt
do \$\$
begin
  if exists (
    select 1 from _bookmeeting_concurrency_repro
    where org_id = 'org-a'
      and starts_at < '2026-06-01T10:00:00Z'::timestamptz
      and ends_at   > '2026-06-01T09:00:00Z'::timestamptz
  ) then
    raise exception 'slot_taken';
  end if;
end \$\$;
insert into _bookmeeting_concurrency_repro (org_id, starts_at, ends_at)
values ('org-a', '2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z');
commit;
SQL
}

echo "=== Scenario 1: WITHOUT the advisory lock (pre-fix behavior) ==="
reset_barrier
run_session "false" &
pid1=$!
run_session "false" &
pid2=$!
wait "$pid1" "$pid2" || true

without_lock_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _bookmeeting_concurrency_repro where org_id = 'org-a'")
echo "Rows inserted for the same slot without the lock: $without_lock_count"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "delete from _bookmeeting_concurrency_repro where org_id = 'org-a'"

echo "=== Scenario 2: WITH the advisory lock (post-fix behavior) ==="
reset_barrier
run_session "true" &
pid1=$!
run_session "true" &
pid2=$!
wait "$pid1" "$pid2" || true

with_lock_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _bookmeeting_concurrency_repro where org_id = 'org-a'")
echo "Rows inserted for the same slot with the lock: $with_lock_count"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "drop table _bookmeeting_concurrency_repro; drop table _bookmeeting_concurrency_barrier;"

echo
if [ "$without_lock_count" -eq 2 ] && [ "$with_lock_count" -eq 1 ]; then
  echo "PROVEN: without the lock both concurrent transactions committed (double-booked);"
  echo "with the lock only one did (the second correctly saw the first's committed row)."
  exit 0
else
  echo "UNEXPECTED RESULT: without_lock=$without_lock_count (want 2), with_lock=$with_lock_count (want 1)"
  exit 1
fi
