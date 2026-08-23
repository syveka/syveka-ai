#!/usr/bin/env bash
# Real-Postgres proof for the D3 hardening in
# src/server/services/calendar-sync.ts (pushBookingEventToGoogle /
# cancelBookingEventOnGoogle's atomic "claim the push" guarded UPDATE).
# Not wired into CI - see tests/integration/booking-concurrency.sh's header
# for why. Run against any scratch Postgres:
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/google-push-claim-concurrency.sh
#
# Mechanism under test: two concurrent invocations of
# pushBookingEventToGoogle for the SAME CalendarEvent, each racing to claim
# it (transition NOT_APPLICABLE -> PENDING) before calling Google. This
# reproduces the claim as a single guarded UPDATE ... WHERE status NOT IN
# ('PENDING','SYNCED') - a real serialization primitive, not a
# read-then-write check: Postgres's own row-level lock on the target row
# makes the two UPDATEs serialize against each other (the second blocks
# until the first's implicit transaction commits, then re-evaluates its
# WHERE clause against the now-committed row and correctly affects 0 rows).
# Only ONE of the two concurrent callers may ever win the claim - proving a
# future manual "retry" could never trivially fire two simultaneous
# adapter.createEvent calls for the same event.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance, e.g. postgresql://postgres:postgres@localhost:5432/postgres}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop table if exists _google_push_claim_repro;
create table _google_push_claim_repro (
  id text primary key,
  google_sync_status text not null default 'NOT_APPLICABLE'
);
insert into _google_push_claim_repro (id) values ('evt-1');
SQL

# Each session: the exact guarded UPDATE pushBookingEventToGoogle issues,
# then reports how many rows it claimed (0 or 1). No advisory lock needed -
# the atomicity comes from the single UPDATE statement's own row lock.
run_claim() {
  psql "$DATABASE_URL" -tAq <<'SQL'
begin;
select pg_sleep(0.3);
with claimed as (
  update _google_push_claim_repro
    set google_sync_status = 'PENDING'
    where id = 'evt-1' and google_sync_status not in ('PENDING', 'SYNCED')
    returning id
)
select count(*) from claimed;
commit;
SQL
}

run_claim > /tmp/_claim_1.out &
pid1=$!
run_claim > /tmp/_claim_2.out &
pid2=$!
wait "$pid1"
wait "$pid2"

claim1=$(tr -d '[:space:]' < /tmp/_claim_1.out)
claim2=$(tr -d '[:space:]' < /tmp/_claim_2.out)
rm -f /tmp/_claim_1.out /tmp/_claim_2.out

final_status=$(psql "$DATABASE_URL" -tAq -c \
  "select google_sync_status from _google_push_claim_repro where id = 'evt-1'")

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "drop table _google_push_claim_repro"

echo "Session 1 claimed: $claim1 row(s). Session 2 claimed: $claim2 row(s). Final status: $final_status"

total_claims=$((claim1 + claim2))
if [ "$total_claims" -eq 1 ] && [ "$final_status" = "PENDING" ]; then
  echo
  echo "PROVEN: exactly one of the two concurrent claims won (total claims=1, not 2) -"
  echo "the guarded UPDATE's row-level lock serialized them, so a caller can never"
  echo "issue two simultaneous adapter.createEvent calls for the same CalendarEvent."
  exit 0
else
  echo "UNEXPECTED RESULT: total_claims=$total_claims (want 1), final_status=$final_status (want PENDING)"
  exit 1
fi
