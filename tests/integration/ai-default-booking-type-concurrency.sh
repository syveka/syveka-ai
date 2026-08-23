#!/usr/bin/env bash
# Real-Postgres proof for the AI-default-BookingType race fixed in
# src/server/services/booking.ts (saveBookingType's isAiBookingDefault
# handling) via src/server/calendar/locks.ts's lockAiDefaultBookingType.
# Not wired into CI - see tests/integration/booking-concurrency.sh's header
# for why. Run against any scratch Postgres:
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/ai-default-booking-type-concurrency.sh
#
# Mechanism under test: two concurrent "claim isAiBookingDefault=true for a
# DIFFERENT BookingType" requests, each doing (1) write my row true, (2)
# clear every OTHER true row in the org. Without serialization, under
# Postgres's default READ COMMITTED isolation neither session's cleanup (2)
# can see the other's row (1) until the other COMMITS - each transaction's
# own snapshot only sees committed data. With near-simultaneous timing
# (this repro uses matched pg_sleep(1) calls to force it), BOTH sessions
# reach their cleanup before EITHER has committed, so BOTH cleanups find
# nothing to clear and BOTH commit with their own row still true - TWO
# defaults, violating "at most one." (A different interleaving - one
# session's cleanup running strictly after the other's commit - instead
# leaves ZERO true rows, since each sees the other's committed claim and
# clears it. Either way the invariant breaks; this repro reliably
# reproduces the two-true case.) A plain transaction around steps (1)+(2)
# does NOT fix this: the two sessions touch DIFFERENT rows, so there is no
# row-level lock forcing them to serialize against each other - only an
# explicit advisory lock, taken as the FIRST statement, does.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance, e.g. postgresql://postgres:postgres@localhost:5432/postgres}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop table if exists _ai_default_concurrency_repro;
create table _ai_default_concurrency_repro (
  id text primary key,
  organization_id text not null,
  is_ai_default boolean not null default false
);
SQL

# $1: row id this session claims as the default. $2: "true"/"false" -
# whether to take the advisory lock first (the fix).
run_session() {
  local row_id="$1"
  local take_lock="$2"
  local lock_stmt=""
  if [ "$take_lock" = "true" ]; then
    lock_stmt="select pg_advisory_xact_lock(hashtext('org-a'), 2);"
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
begin;
$lock_stmt
insert into _ai_default_concurrency_repro (id, organization_id, is_ai_default)
values ('$row_id', 'org-a', true);
select pg_sleep(1);
update _ai_default_concurrency_repro
  set is_ai_default = false
  where organization_id = 'org-a' and id <> '$row_id' and is_ai_default = true;
commit;
SQL
}

echo "=== Scenario 1: WITHOUT the advisory lock (pre-fix behavior) ==="
run_session "bt-x" "false" &
pid1=$!
run_session "bt-y" "false" &
pid2=$!
wait "$pid1" "$pid2" || true

without_lock_true_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _ai_default_concurrency_repro where organization_id = 'org-a' and is_ai_default = true")
without_lock_total=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _ai_default_concurrency_repro where organization_id = 'org-a'")
echo "Rows claiming true, without the lock: $without_lock_true_count (out of $without_lock_total rows total)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "delete from _ai_default_concurrency_repro where organization_id = 'org-a'"

echo "=== Scenario 2: WITH the advisory lock (post-fix behavior) ==="
run_session "bt-x" "true" &
pid1=$!
run_session "bt-y" "true" &
pid2=$!
wait "$pid1" "$pid2" || true

with_lock_true_count=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _ai_default_concurrency_repro where organization_id = 'org-a' and is_ai_default = true")
with_lock_total=$(psql "$DATABASE_URL" -tAq -c \
  "select count(*) from _ai_default_concurrency_repro where organization_id = 'org-a'")
echo "Rows claiming true, with the lock: $with_lock_true_count (out of $with_lock_total rows total)"

echo "=== Scenario 3: tenant isolation - a concurrent claim in a DIFFERENT org must never affect org-a ==="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "insert into _ai_default_concurrency_repro (id, organization_id, is_ai_default) values ('bt-other-org', 'org-b', true)"
run_session "bt-z" "true" &
pid1=$!
wait "$pid1" || true
other_org_still_true=$(psql "$DATABASE_URL" -tAq -c \
  "select is_ai_default from _ai_default_concurrency_repro where id = 'bt-other-org'")
echo "org-b's row after an org-a claim: is_ai_default=$other_org_still_true (must still be t)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "drop table _ai_default_concurrency_repro"

echo
if [ "$without_lock_true_count" -ne 1 ] && [ "$with_lock_true_count" -eq 1 ] && [ "$other_org_still_true" = "t" ]; then
  echo "PROVEN:"
  echo "  - without the lock, two concurrent claims for different rows produced"
  echo "    $without_lock_true_count true rows (not the required exactly-one) - neither individual"
  echo "    request could have detected this from its own result."
  echo "  - with the lock, exactly ONE row ended up true - a deterministic winner, every time."
  echo "  - a concurrent claim in a different organization never touched org-a's or org-b's state"
  echo "    across tenants."
  exit 0
else
  echo "UNEXPECTED RESULT: without_lock_true=$without_lock_true_count (want != 1), with_lock_true=$with_lock_true_count (want 1), other_org_still_true=$other_org_still_true (want t)"
  exit 1
fi
