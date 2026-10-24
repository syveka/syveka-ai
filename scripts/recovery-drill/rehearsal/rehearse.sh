#!/usr/bin/env bash
# SYNTHETIC end-to-end rehearsal of the drill scripts, with negative controls.
#
# Usage: rehearse.sh <empty-work-dir>
#
# Every database is a local throwaway container with --network none, no
# published ports and no bind mounts; files move only as byte streams over
# `docker exec -i`. Only fake data is used (rehearsal/seed-*.sql). Nothing
# connects to a remote database. Containers are removed on exit.
#
# Stages:
#   A. production-shaped synthetic source (supabase/postgres image): the 31
#      migrations production has applied, Prisma's migration history, the
#      2026-10-21 manual RLS remediation, Auth/Storage rows and a sensitive
#      value in every column the drill must neutralize, including secrets
#      inside JSON, nested JSON, free text and text arrays; dumped with the
#      same pg_dumpall/pg_dump options as the §4 dump script.
#   B. s5 positive run; every check sees its synthetic value before
#      sanitizing; marker scans before and after.
#   C. s5 negative controls (sabotaged copies of the scripts), each of which
#      must stop with no sanitized archive released: a missing sanitization
#      statement, a SQL error in the checks, a missing check, an omitted JSON
#      scrub, an omitted text scrub, an omitted workflow-recipient rule, and
#      the text scrub plus its database check both disabled (the archive scan).
#   D. s6 localtest into a fresh empty destination, then wrong-version and
#      non-empty-target rejections, then the pending migration applied locally
#      and tests/staging/release-invariants.sql before and after.
#   E. on a second empty destination: the Auth, Storage and migration-history
#      guards one by one (refused before any write), a restore failing mid-load
#      (rolled back), and a verification failure after commit (DATA REMAINS).
#   F. remote-mode identity validation with no network: production, staging,
#      mismatched and malformed targets are refused before the password
#      prompt, before any container starts.
set -uo pipefail
umask 077
export MSYS_NO_PATHCONV=1

HERE=$(cd "$(dirname "$0")" && pwd)
DRILL=$(cd "$HERE/.." && pwd)
REPO=$(cd "$DRILL/../.." && pwd)
SUPA_IMG=public.ecr.aws/supabase/postgres:17.6.1.167
PENDING=20261014000000_secure_prisma_migrations_table
MARKER_ERE='SYNTHETIC-?SECRET'

WORK=${1:-}
[ -n "$WORK" ] || { echo "usage: $0 <empty-work-dir>"; exit 2; }
mkdir -p "$WORK" && WORK=$(cd "$WORK" && pwd)
[ -z "$(ls -A "$WORK")" ] || { echo "STOP: $WORK is not empty"; exit 2; }
for img in "$SUPA_IMG" pgvector/pgvector:pg17; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "STOP: image $img is not present locally (do not pull now)"; exit 2; }
done

SUMMARY="$WORK/SUMMARY.txt"
fails=0
result() { printf '%s %s\n' "$1" "$2" | tee -a "$SUMMARY"; [ "$1" = PASS ] || fails=$((fails + 1)); }
CONTAINERS=()
cleanup() { for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1; done; }
trap cleanup EXIT

TS=$(date -u +%Y%m%dT%H%M%SZ)
rand() { head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# start_supabase <name>: --network none, no ports, no mounts; prints nothing.
start_supabase() {
  local name=$1 pw=$2
  docker run -d --rm --name "$name" --network none --memory 1g -e POSTGRES_PASSWORD="$pw" "$SUPA_IMG" >/dev/null || return 1
  CONTAINERS+=("$name")
  for _ in $(seq 1 90); do
    docker exec -e PGPASSWORD="$pw" "$name" psql -X -q -h localhost -U postgres -d postgres -c 'select 1' >/dev/null 2>&1 && break
    sleep 2
  done
  sleep 3
  docker exec -e PGPASSWORD="$pw" "$name" psql -X -q -h localhost -U postgres -d postgres -c 'select 1' >/dev/null 2>&1
}
isolated() {
  [ "$(docker inspect -f '{{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}} {{len .HostConfig.Binds}}' "$1")" = "none 0 0" ]
}
# sql <container> <password> <user> [psql args...]  (SQL on stdin or via -c)
sql() { local c=$1 pw=$2 u=$3; shift 3; docker exec -i -e PGPASSWORD="$pw" "$c" psql -X -q -v ON_ERROR_STOP=1 -h localhost -U "$u" -d postgres "$@"; }
marker_count() {  # marker_count <container> <archive-file>: plain-text marker hits in an archive
  docker exec -i "$1" pg_restore -f - < "$2" 2>/dev/null | grep -oE "$MARKER_ERE" | wc -l | tr -d ' '
}

# ======================================================================== A
SRC=syveka-rehearsal-src-$TS; SRC_PW=$(rand)
start_supabase "$SRC" "$SRC_PW" || { echo "STOP: source container did not start"; exit 1; }
isolated "$SRC" && result PASS "A0 source container isolated (network none, 0 ports, 0 mounts)" || result FAIL "A0 source isolation"
SUPERUSER=supabase_admin
sql "$SRC" "$SRC_PW" "$SUPERUSER" -c 'select 1' >/dev/null 2>&1 || SUPERUSER=postgres
echo "A: superuser for the auth-table approximations: $SUPERUSER" | tee -a "$SUMMARY"
SRC_VERSION=$(sql "$SRC" "$SRC_PW" postgres -At -c "select current_setting('server_version')")
echo "A: source server_version=$SRC_VERSION" | tee -a "$SUMMARY"

sql "$SRC" "$SRC_PW" "$SUPERUSER" --single-transaction < "$HERE/seed-auth-extras.sql" > "$WORK/seed-auth.log" 2>&1 \
  && result PASS "A3 hosted-Auth approximations created (auth.jwt, session/token/MFA tables)" || { result FAIL "A3 auth extras"; cat "$WORK/seed-auth.log"; exit 1; }
mig_ok=1
sql "$SRC" "$SRC_PW" postgres <<'SQL' || mig_ok=0
create table public."_prisma_migrations" (
  "id" varchar(36) primary key not null, "checksum" varchar(64) not null,
  "finished_at" timestamptz, "migration_name" varchar(255) not null, "logs" text,
  "rolled_back_at" timestamptz, "started_at" timestamptz not null default now(),
  "applied_steps_count" integer not null default 0);
SQL
for dir in "$REPO"/prisma/migrations/*/; do
  name=$(basename "$dir")
  [ "$name" = "$PENDING" ] && continue
  sum=$(sha256sum "$dir/migration.sql" | cut -c1-64)
  { cat "$dir/migration.sql"
    printf "\ninsert into public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) values (gen_random_uuid()::text, '%s', now(), '%s', 1);\n" "$sum" "$name"
  } | sql "$SRC" "$SRC_PW" postgres --single-transaction > "$WORK/migrate-$name.log" 2>&1 || { mig_ok=0; echo "migration $name failed:"; tail -5 "$WORK/migrate-$name.log"; break; }
done
APPLIED=$(sql "$SRC" "$SRC_PW" postgres -At -c "select count(*) from public._prisma_migrations where finished_at is not null")
[ "$mig_ok" = 1 ] && [ "$APPLIED" = 31 ] && result PASS "A1 31 production migrations applied with Prisma history ($APPLIED rows)" \
  || { result FAIL "A1 migrations (applied=$APPLIED)"; exit 1; }
# Production state since 2026-10-21 (#355): the pending migration's statements
# were run by hand, without a history row.
sql "$SRC" "$SRC_PW" postgres --single-transaction < "$REPO/prisma/migrations/$PENDING/migration.sql" >/dev/null \
  && result PASS "A2 manual 2026-10-21 remediation reproduced (no history row)" || result FAIL "A2 manual remediation"
sql "$SRC" "$SRC_PW" postgres --single-transaction < "$HERE/seed-data.sql" > "$WORK/seed-data.log" 2>&1 \
  && result PASS "A4 synthetic sensitive data seeded" || { result FAIL "A4 seed"; cat "$WORK/seed-data.log"; exit 1; }

RAW="$WORK/raw"; mkdir -p "$RAW"
docker exec -e PGPASSWORD="$SRC_PW" "$SRC" pg_dumpall --roles-only --no-role-passwords -h localhost -U postgres -l postgres \
  > "$RAW/roles-$TS.sql" 2> "$WORK/dumpall.err" || { result FAIL "A5 pg_dumpall --roles-only as postgres"; cat "$WORK/dumpall.err"; exit 1; }
docker exec -e PGPASSWORD="$SRC_PW" "$SRC" pg_dump -Fc --schema=public --schema=auth --schema=storage --lock-wait-timeout=2000 \
  -h localhost -U postgres -d postgres > "$RAW/syveka-synthetic-$TS.dump" 2> "$WORK/dump.err" \
  || { result FAIL "A5 pg_dump of public/auth/storage as postgres"; cat "$WORK/dump.err"; exit 1; }
( cd "$RAW" && sha256sum "roles-$TS.sql" "syveka-synthetic-$TS.dump" > "SHA256SUMS-$TS.txt" )
result PASS "A5 synthetic dump written with the §4 options as postgres ($(stat -c %s "$RAW/syveka-synthetic-$TS.dump") bytes)"
RAW_HITS=$(marker_count "$SRC" "$RAW/syveka-synthetic-$TS.dump")
[ "$RAW_HITS" -gt 0 ] && result PASS "A6 negative control: the raw archive contains the marker ($RAW_HITS hits)" || result FAIL "A6 raw marker scan found nothing"
docker rm -f "$SRC" >/dev/null 2>&1

# ======================================================================== B
bash "$DRILL/s5-sanitize-offline.sh" "$RAW" > "$WORK/s5-positive.log" 2>&1
RC=$?
S5OUT=$(ls -d "$RAW"/sanitized-* 2>/dev/null | head -1)
[ "$RC" = 0 ] && [ -s "$S5OUT/sanitized-public.dump" ] && result PASS "B1 s5 positive run: S5_RESULT=PASS" \
  || { result FAIL "B1 s5 positive run (rc=$RC)"; tail -15 "$WORK/s5-positive.log"; exit 1; }
# Every seeded category must be detected before sanitizing (proves each check sees its value).
# (auth_saml_relay_states is not seeded; the unlisted-table check has nothing to find by design.)
NOT_DETECTED=$(awk -F'|' '$2 != "auth_unlisted_tables_with_rows" && $2 != "auth_saml_relay_states" && $3 !~ /^[1-9]/ {print $2 "=" $3}' "$S5OUT/checks-raw.txt" | tr '\n' ' ')
[ -z "$NOT_DETECTED" ] && result PASS "B2 every check detected its synthetic value before sanitizing" \
  || result FAIL "B2 checks that saw nothing before sanitizing: $NOT_DETECTED"
grep -q 'check|auth_user_secrets|0' "$S5OUT/checks-sanitized.txt" && result PASS "B3 all checks 0 after sanitizing" || result FAIL "B3 sanitized checks"
grep -q '^rows|auth.identities|2$' "$S5OUT/rowcounts-sanitized.txt" && grep -q '^rows|auth.users|2$' "$S5OUT/rowcounts-sanitized.txt" \
  && result PASS "B4 identities kept (auth.users=2, auth.identities=2)" || result FAIL "B4 identities"

# ======================================================================== C
# neg_s5 <label> <tag> <file> <sed-expr> [<file> <sed-expr> ...]: a sabotaged
# copy of the scripts must STOP and release no sanitized archive.
neg_s5() {
  local label=$1 tag=$2 copy="$WORK/neg-$2" file expr
  shift 2
  mkdir -p "$copy/scripts/recovery-drill" && cp -r "$DRILL"/. "$copy/scripts/recovery-drill/"
  while [ "$#" -ge 2 ]; do
    file=$1; expr=$2; shift 2
    sed -i "$expr" "$copy/scripts/recovery-drill/$file"
    cmp -s "$DRILL/$file" "$copy/scripts/recovery-drill/$file" && { result FAIL "$label (sabotage of $file did not apply)"; return; }
  done
  local before; before=$(ls -d "$RAW"/sanitized-* | wc -l)
  bash "$copy/scripts/recovery-drill/s5-sanitize-offline.sh" "$RAW" > "$WORK/neg-$tag.log" 2>&1
  local rc=$? newest; newest=$(ls -td "$RAW"/sanitized-* | head -1)
  if [ "$rc" != 0 ] && [ "$(ls -d "$RAW"/sanitized-* | wc -l)" -gt "$before" ] \
     && [ ! -e "$newest/sanitized-public.dump" ] && [ ! -e "$newest/sanitized-managed.dump" ]; then
    result PASS "$label -> $(grep -o 'S5_RESULT=STOP.*' "$WORK/neg-$tag.log" | head -1)"
  else
    result FAIL "$label (rc=$rc)"
  fi
}
neg_s5 "C1 a missing sanitization statement stops s5" skip-webhooks \
  sanitize.sql '/^delete from public.webhook_endpoints;$/d'
neg_s5 "C2 a SQL error in the checks stops s5" sql-error \
  sanitize-checks.sql 's/from public.webhook_endpoints$/from public.webhook_endpoints_missing/'
neg_s5 "C3 a check missing from the output stops s5" missing-check \
  sanitize-checks.sql "/^select 'check', 'active_api_keys'/,/^union all\$/d"
neg_s5 "C4 an omitted JSON scrub stops s5" skip-json-scrub \
  sanitize.sql '/^select pg_temp.drill_scrub_json_columns();$/d'
neg_s5 "C5 an omitted text scrub stops s5" skip-text-scrub \
  sanitize.sql '/^select pg_temp.drill_scrub_text_columns();$/d'
neg_s5 "C6 an omitted workflow-recipient rule stops s5 (independent jsonpath check)" skip-email-rule \
  scrub-functions.sql 's/if is_email_step and item.key = .to. then -- rule:workflow-email/if false then -- rule:workflow-email/'
neg_s5 "C7 the archive scan stops s5 when the text scrub and its database check are both disabled" skip-text-and-check \
  sanitize.sql '/^select pg_temp.drill_scrub_text_columns();$/d' \
  sanitize-checks.sql "s/pg_temp.drill_count_sensitive('text')::text/'0'/"
grep -q 'known secret format' "$WORK/neg-skip-text-and-check.log" \
  && result PASS "C7b the C7 stop came from the archive scan, not the database checks" || result FAIL "C7b the archive scan did not catch it"

# ======================================================================== D
DST=syveka-rehearsal-dst-$TS; DST_PW=$(rand)
start_supabase "$DST" "$DST_PW" || { result FAIL "D0 destination container did not start"; exit 1; }
isolated "$DST" && result PASS "D0 destination container isolated" || result FAIL "D0 destination isolation"
# The destination stands in for a hosted project, whose Auth has the same tables.
sql "$DST" "$DST_PW" "$SUPERUSER" --single-transaction < "$HERE/seed-auth-extras.sql" > /dev/null 2>&1 || result FAIL "D0 destination auth approximations"
SAN_HITS=$(( $(marker_count "$DST" "$S5OUT/sanitized-public.dump") + $(marker_count "$DST" "$S5OUT/sanitized-managed.dump") ))
[ "$SAN_HITS" = 0 ] && result PASS "D1 sanitized archives contain no marker" || result FAIL "D1 sanitized archives contain $SAN_HITS marker hits"

s6() { S6_MODE=localtest S6_LOCAL_CONTAINER="$1" S6_EXPECT_VERSION_PREFIX="$2" S6_CONFIRM='RESTORE LOCAL TEST' PGPASSWORD="$3" \
  bash "$DRILL/s6-restore-disposable.sh" "$S5OUT" > "$4" 2>&1; }
DST_VERSION=$(sql "$DST" "$DST_PW" postgres -At -c "select current_setting('server_version')")
DST_PREFIX=${DST_VERSION%% *}
s6 "$DST" "17.11" "$DST_PW" "$WORK/s6-wrong-version.log"; RC=$?
[ "$RC" != 0 ] && grep -q 'not 17.11.x' "$WORK/s6-wrong-version.log" && [ "$(sql "$DST" "$DST_PW" postgres -At -c "select count(*) from pg_tables where schemaname = 'public'")" = 0 ] \
  && result PASS "D2 wrong-target rejection before any write (version $DST_PREFIX is not 17.11)" || result FAIL "D2 wrong-target rejection (rc=$RC)"

s6 "$DST" "$DST_PREFIX" "$DST_PW" "$WORK/s6-positive.log"; RC=$?
[ "$RC" = 0 ] && result PASS "D3 s6 positive run: $(grep -o 'time_to_restore_seconds=[0-9]*' "$WORK/s6-positive.log"), checks 0, row counts match, pending = $PENDING" \
  || { result FAIL "D3 s6 positive run (rc=$RC)"; tail -15 "$WORK/s6-positive.log"; }

TABLES_BEFORE=$(sql "$DST" "$DST_PW" postgres -At -c "select count(*) from pg_tables where schemaname = 'public'")
s6 "$DST" "$DST_PREFIX" "$DST_PW" "$WORK/s6-nonempty.log"; RC=$?
TABLES_AFTER=$(sql "$DST" "$DST_PW" postgres -At -c "select count(*) from pg_tables where schemaname = 'public'")
[ "$RC" != 0 ] && grep -q 'stage=destination-guard reason: destination already has a migration history' "$WORK/s6-nonempty.log" && [ "$TABLES_BEFORE" = "$TABLES_AFTER" ] \
  && result PASS "D4 non-empty-target rejection before any write ($TABLES_AFTER public tables unchanged)" || result FAIL "D4 non-empty-target rejection (rc=$RC)"

if [ "$RC" != 0 ] && [ -s "$S5OUT/sanitized-public.dump" ]; then
  sql "$DST" "$DST_PW" postgres < "$REPO/tests/staging/release-invariants.sql" > "$WORK/invariants-before.log" 2>&1; RC=$?
  [ "$RC" != 0 ] && grep -q "$PENDING is not successfully applied\|migration .* is not successfully applied" "$WORK/invariants-before.log" \
    && result PASS "D5 release invariants fail while $PENDING is pending" || result FAIL "D5 invariants before the migration (rc=$RC): $(grep -m1 -o 'STAGING RELEASE FAIL.*' "$WORK/invariants-before.log")"
  SUM=$(sha256sum "$REPO/prisma/migrations/$PENDING/migration.sql" | cut -c1-64)
  { cat "$REPO/prisma/migrations/$PENDING/migration.sql"
    printf "\ninsert into public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) values (gen_random_uuid()::text, '%s', now(), '%s', 1);\n" "$SUM" "$PENDING"
  } | sql "$DST" "$DST_PW" postgres --single-transaction > "$WORK/apply-pending.log" 2>&1 \
    && result PASS "D6 pending migration applied locally on the synthetic destination (as Prisma records it)" || result FAIL "D6 apply pending migration"
  sql "$DST" "$DST_PW" postgres < "$REPO/tests/staging/release-invariants.sql" > "$WORK/invariants-after.log" 2>&1; RC=$?
  [ "$RC" = 0 ] && grep -q 'ALL STAGING RELEASE INVARIANTS PASSED' "$WORK/invariants-after.log" \
    && result PASS "D7 release invariants pass after the migration" || result FAIL "D7 invariants after the migration (rc=$RC): $(grep -m1 -o 'STAGING RELEASE FAIL.*\|ERROR.*' "$WORK/invariants-after.log")"
  sql "$DST" "$DST_PW" postgres -At -c "select migration_name from public._prisma_migrations where finished_at is not null and rolled_back_at is null" > "$WORK/applied-after.txt"
  # shellcheck source=../lib.sh
  . "$DRILL/lib.sh"
  [ -z "$(pending_migrations "$REPO/prisma/migrations" "$WORK/applied-after.txt")" ] \
    && result PASS "D8 migration history up to date at this commit ($(grep -c '' "$WORK/applied-after.txt") rows)" || result FAIL "D8 still pending"
fi
docker rm -f "$DST" >/dev/null 2>&1

# ======================================================================== E
# One fresh empty destination for: each specific guard (refuses before any
# write), a restore that fails mid-load (rolls back, destination unchanged),
# and a verification failure after commit (DATA REMAINS, nothing deleted).
ATM=syveka-rehearsal-guards-$TS; ATM_PW=$(rand)
start_supabase "$ATM" "$ATM_PW" || { result FAIL "E0 container"; exit 1; }
isolated "$ATM" && result PASS "E0 guard/rollback destination isolated" || result FAIL "E0 isolation"
sql "$ATM" "$ATM_PW" "$SUPERUSER" --single-transaction < "$HERE/seed-auth-extras.sql" > /dev/null 2>&1 || result FAIL "E0 auth approximations"
public_relations() {
  sql "$ATM" "$ATM_PW" postgres -At -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')"
}
guard_case() {  # guard_case <label> <tag> <setup-sql> <expected-message> <undo-sql>
  sql "$ATM" "$ATM_PW" "$SUPERUSER" -c "$3" > /dev/null || { result FAIL "$1 (setup)"; return; }
  local before; before=$(public_relations)
  s6 "$ATM" "$DST_PREFIX" "$ATM_PW" "$WORK/s6-guard-$2.log"; local rc=$?
  if [ "$rc" != 0 ] && grep -q "stage=destination-guard reason: $4" "$WORK/s6-guard-$2.log" \
     && [ "$(public_relations)" = "$before" ] && ! grep -q 'DATA REMAINS' "$WORK/s6-guard-$2.log"; then
    result PASS "$1 -> refused before any write"
  else
    result FAIL "$1 (rc=$rc)"
  fi
  sql "$ATM" "$ATM_PW" "$SUPERUSER" -c "$5" > /dev/null || result FAIL "$1 (undo)"
}
guard_case "E1 an existing Auth user is refused" auth \
  "insert into auth.users (id, email) values ('99999999-0000-4000-8000-000000000001', 'existing@drill.invalid')" \
  "destination already has 1 Auth user" "delete from auth.users"
guard_case "E2 existing Storage rows are refused" storage \
  "insert into storage.buckets (id, name) values ('existing', 'existing')" \
  "destination already has Storage rows" "delete from storage.buckets"
guard_case "E3 an existing migration history is refused" history \
  "create table public._prisma_migrations (id text)" \
  "destination already has a migration history" "drop table public._prisma_migrations"
guard_case "E3b any other public relation is refused" public \
  "create table public.preexisting (id int)" \
  "destination is not empty: 1 relation(s) in public" "drop table public.preexisting"

# A destination whose Auth schema lacks a column the archive carries: the
# managed-table load fails after the public tables were created in the same
# transaction, which must roll back.
sql "$ATM" "$ATM_PW" "$SUPERUSER" -c "alter table auth.users drop column recovery_token" >/dev/null
s6 "$ATM" "$DST_PREFIX" "$ATM_PW" "$WORK/s6-atomic.log"; RC=$?
LEFT=$(public_relations)
if [ "$RC" != 0 ] && grep -q 'stage=restore reason: RESTORE ROLLED BACK' "$WORK/s6-atomic.log" && [ "$LEFT" = 0 ] \
   && ! grep -q 'DATA REMAINS' "$WORK/s6-atomic.log"; then
  result PASS "E4 a restore failing mid-load rolls back: destination empty, no cleanup banner"
else
  result FAIL "E4 atomicity (rc=$RC, public relations left=$LEFT)"
fi
sql "$ATM" "$ATM_PW" "$SUPERUSER" -c "alter table auth.users add column recovery_token character varying(255)" >/dev/null

# A verification failure AFTER the commit (a sabotaged copy whose privilege
# fingerprint cannot match): data stays, the banner names the stage, and the
# script deletes nothing.
POST="$WORK/neg-post-commit"
mkdir -p "$POST/scripts/recovery-drill" "$POST/prisma" && cp -r "$DRILL"/. "$POST/scripts/recovery-drill/" && cp -r "$REPO/prisma/migrations" "$POST/prisma/"
sed -i "s/^order by 2, 3, 4;\$/union all select 'acl', 'table', 'zz_injected', 'anon', 'SELECT' order by 2, 3, 4;/" "$POST/scripts/recovery-drill/privileges.sql"
cmp -s "$DRILL/privileges.sql" "$POST/scripts/recovery-drill/privileges.sql" && result FAIL "E5 (sabotage did not apply)"
S6_MODE=localtest S6_LOCAL_CONTAINER="$ATM" S6_EXPECT_VERSION_PREFIX="$DST_PREFIX" S6_CONFIRM='RESTORE LOCAL TEST' PGPASSWORD="$ATM_PW" \
  bash "$POST/scripts/recovery-drill/s6-restore-disposable.sh" "$S5OUT" > "$WORK/s6-post-commit.log" 2>&1
RC=$?
LEFT=$(public_relations)
if [ "$RC" != 0 ] && grep -q 'DATA REMAINS — OWNER CLEANUP REQUIRED (failed stage: verify-privileges)' "$WORK/s6-post-commit.log" \
   && [ "$LEFT" -gt 0 ]; then
  result PASS "E5 a post-commit verification failure prints DATA REMAINS with the stage; data left in place ($LEFT public relations), nothing deleted"
else
  result FAIL "E5 post-commit failure handling (rc=$RC, public relations=$LEFT)"
fi
docker rm -f "$ATM" >/dev/null 2>&1

# ======================================================================== F
# Remote-mode input validation, with NO network connection: every input set
# below must be refused before the password prompt, before any container is
# started and before any output directory is created.
E_REF=eeeeeeeeeeeeeeeeeeee; P_REF=pppppppppppppppppppp; S_REF=ssssssssssssssssssss
HOST=aws-0-eu-west-1.pooler.supabase.com
remote_case() {  # remote_case <label> <tag> <host> <expected> <production> <staging> <user> <expected-message>
  local before log="$WORK/s6-remote-$2.log"
  before=$(ls -d "$S5OUT"/restore-remote-* 2>/dev/null | wc -l)
  printf '%s\n%s\n%s\n%s\n%s\n' "$3" "$4" "$5" "$6" "$7" \
    | S6_MODE=remote bash "$DRILL/s6-restore-disposable.sh" "$S5OUT" > "$log" 2>&1
  local rc=$?
  if [ "$rc" != 0 ] && grep -qF "target identity rejected: $8" "$log" && ! grep -q 'empty password' "$log" \
     && [ "$(ls -d "$S5OUT"/restore-remote-* 2>/dev/null | wc -l)" = "$before" ] \
     && [ -z "$(docker ps -aq --filter name=syveka-s6-client)" ]; then
    result PASS "$1"
  else
    result FAIL "$1 (rc=$rc): $(tail -1 "$log")"
  fi
}
remote_case "F1 a connection user on the PRODUCTION project is refused" prod "$HOST" "$E_REF" "$P_REF" "$S_REF" "postgres.$P_REF" "the connection user targets PRODUCTION"
remote_case "F2 a connection user on the STAGING project is refused" staging "$HOST" "$E_REF" "$P_REF" "$S_REF" "postgres.$S_REF" "the connection user targets STAGING"
remote_case "F3 a connection user on another project is refused" other "$HOST" "$E_REF" "$P_REF" "$S_REF" "postgres.aaaaaaaaaaaaaaaaaaaa" "the connection user's project is not the expected disposable project"
remote_case "F4 an expected ref equal to production is refused" exp-prod "$HOST" "$P_REF" "$P_REF" "$S_REF" "postgres.$P_REF" "the expected disposable ref is the PRODUCTION ref"
remote_case "F5 an expected ref equal to staging is refused" exp-staging "$HOST" "$S_REF" "$P_REF" "$S_REF" "postgres.$S_REF" "the expected disposable ref is the STAGING ref"
remote_case "F6 a non-pooler host is refused" host "db.example.invalid" "$E_REF" "$P_REF" "$S_REF" "postgres.$E_REF" "host is not a Supabase session pooler host"
remote_case "F7 a malformed ref is refused" malformed "$HOST" "short" "$P_REF" "$S_REF" "postgres.$E_REF" "a project ref is not 20 lowercase letters/digits"

echo "rehearsal: $fails failure(s); work dir $WORK" | tee -a "$SUMMARY"
exit "$fails"
