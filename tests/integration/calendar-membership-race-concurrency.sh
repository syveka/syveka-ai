#!/usr/bin/env bash
# Real-Postgres proof for the calendar membership lock (#73 residual R1):
# lockCalendarMember() in src/server/calendar/locks.ts takes
#   SELECT ... FROM organization_members m JOIN organizations o ...
#   FOR SHARE OF m, o
# before persisting calendar data for a user, and removeMember()
# (src/server/services/members.ts) DELETEs the membership row, then
# invalidates the user's calendar connections, in one transaction.
#
# Under READ COMMITTED this makes the two mutually exclusive:
#   A. writer locks first  -> the removal waits; its invalidation then clears
#      what the writer committed;
#   B. removal first       -> the writer waits, re-reads, finds no membership
#      row, and writes nothing;
#   C. (unfixed baseline)  -> a plain check-then-write without the lock writes
#      after the removal has committed.
#
# Not wired into CI (same as booking-concurrency.sh): manual/local
# verification against a scratch Postgres, e.g.
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/calendar-membership-race-concurrency.sh
#
# Uses minimal throwaway tables with the same lock statements; the property
# under test is Postgres row locking, not the real tables' other columns.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance}"

q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA "$@"; }

reset() {
  q <<'SQL'
drop table if exists _r1_events, _r1_connections, _r1_members, _r1_orgs;
create table _r1_orgs (id text primary key, deleted_at timestamptz);
create table _r1_members (org_id text references _r1_orgs(id), user_id text, primary key (org_id, user_id));
create table _r1_connections (id text primary key, org_id text, user_id text, status text, token text);
create table _r1_events (id serial primary key, org_id text, title text);
insert into _r1_orgs values ('org-a', null);
insert into _r1_members values ('org-a', 'u1');
insert into _r1_connections values ('c1', 'org-a', 'u1', 'CONNECTED', 'old-token');
SQL
}

# The writer: the fixed persist path (lock, then write), or the unfixed
# baseline (plain check, then write). $1: fixed|unfixed. $2: seconds to hold
# the transaction open after the check, before writing.
writer() {
  local mode="$1" hold="$2" check
  if [ "$mode" = "fixed" ]; then
    check="perform 1 from _r1_members m join _r1_orgs o on o.id = m.org_id
           where m.org_id = 'org-a' and m.user_id = 'u1' and o.deleted_at is null
           for share of m, o;"
  else
    check="perform 1 from _r1_members m join _r1_orgs o on o.id = m.org_id
           where m.org_id = 'org-a' and m.user_id = 'u1' and o.deleted_at is null;"
  fi
  q <<SQL
begin;
do \$\$
begin
  $check
  if found then
    perform pg_sleep($hold);
    insert into _r1_events (org_id, title) values ('org-a', 'imported');
    update _r1_connections set token = 'refreshed-token', status = 'CONNECTED' where id = 'c1';
  end if;
end \$\$;
commit;
SQL
}

# The removal: DELETE the membership, then invalidate connections, in one
# transaction. $1: seconds between the DELETE and the invalidation/commit.
removal() {
  local hold="$1"
  q <<SQL
begin;
delete from _r1_members where org_id = 'org-a' and user_id = 'u1';
select pg_sleep($hold);
update _r1_connections set status = 'DISCONNECTED', token = null where org_id = 'org-a' and user_id = 'u1';
commit;
SQL
}

state() {
  q -c "select (select count(*) from _r1_events) || ' ' || (select coalesce(token, 'null') || '/' || status from _r1_connections where id = 'c1')"
}

fail=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi
}

# A. Fixed, writer first: the removal waits for the writer, then clears its token.
reset
writer fixed 2 &
sleep 0.5
removal 0
wait
check "A fixed, writer locks first: write lands, removal then invalidates it" "$(state)" "1 null/DISCONNECTED"

# B. Fixed, removal first (uncommitted while the writer arrives): no write.
reset
removal 2 &
sleep 0.5
writer fixed 0
wait
check "B fixed, removal first: writer waits, sees no membership, writes nothing" "$(state)" "0 null/DISCONNECTED"

# C. Unfixed baseline: plain check passes before the removal commits, write lands after it.
reset
writer unfixed 2 &
sleep 0.5
removal 0
wait
check "C unfixed baseline (expected to show the race): event and token written after removal" "$(state)" "1 refreshed-token/CONNECTED"

q -c "drop table if exists _r1_events, _r1_connections, _r1_members, _r1_orgs" >/dev/null
exit $fail
