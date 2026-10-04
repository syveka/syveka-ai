#!/usr/bin/env bash
# Real-Postgres proof for public booking links of removed members:
# createPublicBooking() / rescheduleBookingViaToken() (src/server/services/
# booking.ts) lock, inside their write transaction and before any write,
#   1. the owner's membership and the organization (lockCalendarMember:
#      FOR SHARE OF m, o), then
#   2. the booking type, which must still be active (lockBookableBookingType:
#      FOR SHARE),
# while removeMember() (src/server/services/members.ts) DELETEs the
# membership and then disables the owner's booking types (UPDATE) in one
# transaction.
#
# Scenarios:
#   A. booking locks first  -> removal waits; the booking commits, then the
#      type is disabled;
#   B. removal first        -> booking waits, finds no membership, books nothing;
#   C. unfixed baseline     -> plain checks, booking lands after the removal;
#   D. reversed lock order (booking type, then membership; NOT what the code
#      does) under the same timing -> Postgres detects a deadlock;
#   E. the code's order under that timing -> no deadlock.
#
# Not wired into CI (same as booking-concurrency.sh): manual/local
# verification against a scratch Postgres, e.g.
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/booking-owner-removal-race-concurrency.sh
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance}"

q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA "$@"; }

reset() {
  q <<'SQL'
drop table if exists _bo_bookings, _bo_types, _bo_members, _bo_orgs;
create table _bo_orgs (id text primary key, deleted_at timestamptz);
create table _bo_members (org_id text references _bo_orgs(id), user_id text, primary key (org_id, user_id));
create table _bo_types (id text primary key, org_id text, owner_id text, is_active boolean, deleted_at timestamptz);
create table _bo_bookings (id serial primary key, type_id text);
insert into _bo_orgs values ('org-a', null);
insert into _bo_members values ('org-a', 'owner');
insert into _bo_types values ('bt-1', 'org-a', 'owner', true, null);
SQL
}

LOCK_MEMBER="perform 1 from _bo_members m join _bo_orgs o on o.id = m.org_id
  where m.org_id = 'org-a' and m.user_id = 'owner' and o.deleted_at is null for share of m, o;"
LOCK_TYPE="perform 1 from _bo_types where id = 'bt-1' and org_id = 'org-a' and owner_id = 'owner'
  and is_active and deleted_at is null for share;"
CHECK_MEMBER="perform 1 from _bo_members m join _bo_orgs o on o.id = m.org_id
  where m.org_id = 'org-a' and m.user_id = 'owner' and o.deleted_at is null;"
CHECK_TYPE="perform 1 from _bo_types where id = 'bt-1' and is_active and deleted_at is null;"

# $1/$2: the two statements, in order; $3: seconds to wait between them;
# $4: seconds to wait before inserting.
booking() {
  local first="$1" second="$2" between="$3" before_insert="$4"
  q <<SQL
begin;
do \$\$
declare ok boolean;
begin
  $first
  ok := found;
  perform pg_sleep($between);
  $second
  ok := ok and found;
  perform pg_sleep($before_insert);
  if ok then insert into _bo_bookings (type_id) values ('bt-1'); end if;
end \$\$;
commit;
SQL
}

# $1: seconds between the membership DELETE and the booking type UPDATE.
removal() {
  q <<SQL
begin;
delete from _bo_members where org_id = 'org-a' and user_id = 'owner';
select pg_sleep($1);
update _bo_types set is_active = false where org_id = 'org-a' and owner_id = 'owner' and is_active;
commit;
SQL
}

state() {
  q -c "select (select count(*) from _bo_bookings) || ' ' || (select is_active from _bo_types where id = 'bt-1')"
}

fail=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: expected '$3', got '$2'"; fail=1; fi
}

# A. Booking holds both locks first; the removal waits, then disables the type.
reset
booking "$LOCK_MEMBER" "$LOCK_TYPE" 0 2 &
sleep 0.5
removal 0
wait
check "A booking locks first: booking commits, then the type is disabled" "$(state)" "1 false"

# B. Removal first (uncommitted when the booking arrives): no booking.
reset
removal 2 &
sleep 0.5
booking "$LOCK_MEMBER" "$LOCK_TYPE" 0 0
wait
check "B removal first: booking waits, finds no membership, books nothing" "$(state)" "0 false"

# C. Unfixed baseline: plain checks pass before the removal commits.
reset
booking "$CHECK_MEMBER" "$CHECK_TYPE" 0 2 &
sleep 0.5
removal 0
wait
check "C unfixed baseline (expected to show the race): booking lands after removal" "$(state)" "1 false"

# D. Reversed order: booking locks the type, removal deletes the membership,
#    booking then waits for the membership row while the removal waits for the
#    type row -> deadlock; Postgres aborts one of them (40P01).
reset
set +e
booking "$LOCK_TYPE" "$LOCK_MEMBER" 1.5 0 >/tmp/_bo_d_booking.log 2>&1 &
pid=$!
sleep 0.5
removal 2 >/tmp/_bo_d_removal.log 2>&1
removal_rc=$?
wait $pid
booking_rc=$?
set -e
if grep -qi "deadlock detected" /tmp/_bo_d_booking.log /tmp/_bo_d_removal.log; then
  echo "PASS  D reversed lock order (not used by the code) deadlocks: detected by Postgres (booking rc=$booking_rc, removal rc=$removal_rc)"
else
  echo "FAIL  D expected a deadlock with the reversed order"; fail=1
fi

# E. The code's order under the same timing: no deadlock, removal wins cleanly.
reset
set +e
booking "$LOCK_MEMBER" "$LOCK_TYPE" 1.5 0 >/tmp/_bo_e_booking.log 2>&1 &
pid=$!
sleep 0.5
removal 2 >/tmp/_bo_e_removal.log 2>&1
removal_rc=$?
wait $pid
booking_rc=$?
set -e
if grep -qi "deadlock" /tmp/_bo_e_booking.log /tmp/_bo_e_removal.log; then
  echo "FAIL  E the code's lock order deadlocked"; fail=1
else
  check "E code's lock order, same timing: no deadlock (rc $booking_rc/$removal_rc)" "$(state)" "1 false"
fi

q -c "drop table if exists _bo_bookings, _bo_types, _bo_members, _bo_orgs" >/dev/null
exit $fail
