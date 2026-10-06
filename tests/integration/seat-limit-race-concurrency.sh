#!/usr/bin/env bash
# Real-Postgres proof for the seat limit at join: acceptInvitation()
# (src/server/services/members.ts) runs, in one transaction,
#   1. lockOrgSeats: pg_advisory_xact_lock(hashtext(orgId), 3);
#   2. the organization check (refused when deleted_at is set);
#   3. countActiveSeats: members of the non-deleted organization;
#   4. the membership INSERT only while the count is below the plan's limit.
#
# Scenarios (plan limit 2, one existing member):
#   A. two concurrent joins with the lock   -> exactly one joins (2 members);
#   B. the unlocked baseline (same timing)  -> both join (3 members: the race);
#   C. a deleted organization               -> nobody joins;
#   D. a held calendar lock on the same org (hashtext(orgId), 0) doesn't
#      block a join: the seat lock has its own key domain.
#
# Not wired into CI (same as the other *-race-concurrency.sh scripts):
# manual/local verification against a scratch Postgres, e.g.
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash tests/integration/seat-limit-race-concurrency.sh
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a scratch Postgres instance}"

q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA "$@"; }

LIMIT=2

reset() {
  q <<'SQL'
drop table if exists _sl_members, _sl_orgs;
create table _sl_orgs (id text primary key, deleted_at timestamptz);
create table _sl_members (org_id text references _sl_orgs(id), user_id text, primary key (org_id, user_id));
insert into _sl_orgs values ('org-a', null);
insert into _sl_members values ('org-a', 'existing');
SQL
}

# $1: user id; $2: "lock" or "nolock"; $3: seconds to hold between count and insert.
join_org() {
  local user="$1" mode="$2" hold="$3" lock_sql=""
  if [ "$mode" = "lock" ]; then
    lock_sql="perform pg_advisory_xact_lock(hashtext('org-a'), 3);"
  fi
  q <<SQL 2>&1 | grep -oE "joined|seat_limit_reached|organization_unavailable" || true
begin;
do \$\$
declare seats int;
begin
  $lock_sql
  if not exists (select 1 from _sl_orgs where id = 'org-a' and deleted_at is null) then
    raise exception 'organization_unavailable';
  end if;
  select count(*) into seats from _sl_members m join _sl_orgs o on o.id = m.org_id
    where m.org_id = 'org-a' and o.deleted_at is null;
  perform pg_sleep($hold);
  if seats >= $LIMIT then
    raise exception 'seat_limit_reached';
  end if;
  insert into _sl_members values ('org-a', '$user');
  raise notice 'joined';
end \$\$;
commit;
SQL
}

members() { q -c "select count(*) from _sl_members where org_id = 'org-a'"; }

fail=0
expect() { # $1 label, $2 actual, $3 expected
  if [ "$2" = "$3" ]; then echo "PASS $1: $2"; else echo "FAIL $1: got $2, expected $3"; fail=1; fi
}

echo "== A. concurrent joins with the seat lock"
reset
join_org u1 lock 1 >/tmp/_sl_a1 & join_org u2 lock 1 >/tmp/_sl_a2 & wait
echo "   outcomes: $(cat /tmp/_sl_a1 /tmp/_sl_a2 | sort | tr '\n' ' ')"
expect "A members" "$(members)" 2

echo "== B. unlocked baseline (the race the lock prevents)"
reset
join_org u1 nolock 1 >/tmp/_sl_b1 & join_org u2 nolock 1 >/tmp/_sl_b2 & wait
echo "   outcomes: $(cat /tmp/_sl_b1 /tmp/_sl_b2 | sort | tr '\n' ' ')"
expect "B members (over the limit)" "$(members)" 3

echo "== C. deleted organization"
reset
q -c "update _sl_orgs set deleted_at = now() where id = 'org-a'"
echo "   outcome: $(join_org u1 lock 0 | tr '\n' ' ')"
expect "C members" "$(members)" 1

echo "== D. a held calendar lock doesn't block the seat lock"
reset
q <<'SQL' &
begin;
select pg_advisory_xact_lock(hashtext('org-a'), 0);
select pg_sleep(3);
commit;
SQL
sleep 0.5
start=$(date +%s)
echo "   outcome: $(join_org u1 lock 0 | tr '\n' ' ')"
elapsed=$(( $(date +%s) - start ))
wait
expect "D join finished before the calendar lock released (<2s)" "$([ "$elapsed" -lt 2 ] && echo yes || echo "no (${elapsed}s)")" yes
expect "D members" "$(members)" 2

q -c "drop table if exists _sl_members, _sl_orgs" >/dev/null
rm -f /tmp/_sl_a1 /tmp/_sl_a2 /tmp/_sl_b1 /tmp/_sl_b2
exit $fail
