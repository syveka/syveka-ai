#!/usr/bin/env bash
# Recovery drill §7 (docs/recovery-drill-checklist.md): on the disposable
# project that s6-restore-disposable.sh restored, apply the one pending
# migration with the real `prisma migrate deploy`, then verify the migration
# history, tests/staging/release-invariants.sql, the three RLS suites (through
# the unchanged scripts/ci/run-rls-check.sh, exactly as staging-release.yml runs
# them) and tests/integration/tenant-relationship-integrity.sql.
#
# Usage: s7-verify-disposable.sh <s6-restore-dir>
#   <s6-restore-dir> is the restore-remote-<TS>/ directory whose evidence file
#   records S6_RESULT=PASS. Output goes to <s6-restore-dir>/verify-<UTC>/.
#
# Identity and credentials:
#   * the same prompts and lib.sh validate_remote_target check as s6: the
#     connection user's project ref must equal the expected disposable ref and
#     differ from production and staging BEFORE the password is asked and
#     before any container starts or connection is made;
#   * the password and the URLs built from it live in this process's memory
#     and reach child processes only through their environment (prisma via
#     DATABASE_URL/DIRECT_URL, psql via PGPASSWORD). They are never written to
#     a file and never passed as a command-line argument. ADMIN_URL, which
#     run-rls-check.sh passes to psql as an argument, carries no password.
#     Environment variables are still readable by the same user and by local
#     administrators while the processes run; this is not a secret store.
#   * every captured output is masked (user, host, password) before it is kept.
#
# What it changes on the destination (all separately authorized at run time):
#   * `prisma migrate deploy`: applies 20261014000000_secure_prisma_migrations_table
#     and records it in _prisma_migrations, as Prisma does. Never applied by hand.
#   * the RLS suites create an ephemeral role and fixtures and remove them.
# The destination already holds the §6 restore, so ANY failure after the
# destination guard leaves data behind: the script prints
# "DATA REMAINS — OWNER CLEANUP REQUIRED (failed stage: <stage>)" and deletes
# nothing. A failed migration stays recorded as failed; it is not resolved,
# rolled back or retried here (that needs its own authorization).
#
# Repeat runs: if the migration is already recorded as finished, migrate
# deploy is not run again and only the verification stages run. A recorded
# but failed or rolled-back attempt stops the script.
set -uo pipefail
umask 077
export MSYS_NO_PATHCONV=1

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

CLIENT_IMG=postgres:17
EXPECT_DB=postgres
EXPECT_TARGET_VERSION_PREFIX=17.11          # syveka-recovery-drill-2026-10-17 (production is 17.6)
EXPECT_PENDING=20261014000000_secure_prisma_migrations_table
ROWCOUNTS_SQL="$HERE/rowcounts.sql"
INVARIANTS_SQL=tests/staging/release-invariants.sql
INTEGRITY_SQL=tests/integration/tenant-relationship-integrity.sql
RLS_RUNNER=scripts/ci/run-rls-check.sh
MIGRATIONS_DIR="$REPO/prisma/migrations"
CONFIRM_PHRASE='VERIFY DISPOSABLE'
MIGRATE_PHRASE='APPLY MIGRATION TO DISPOSABLE'

say() { printf '%s\n' "$*"; }
EVID=''
CONNECTED=0
STAGE=preflight
note() { say "$*"; [ -n "$EVID" ] && printf '%s\n' "$*" >> "$EVID"; }
stop() {
  note "S7_RESULT=STOP stage=$STAGE reason: $*"
  if [ "$CONNECTED" = 1 ]; then
    note "DATA REMAINS — OWNER CLEANUP REQUIRED (failed stage: $STAGE). The destination still holds the §6 restored sanitized data and whatever migration state is recorded above. s7 deleted nothing."
  fi
  exit 1
}

CLIENT=''; SHIM_DIR=''
cleanup() {
  [ -n "$CLIENT" ] && docker rm -f "$CLIENT" >/dev/null 2>&1
  [ -n "$SHIM_DIR" ] && rm -rf "$SHIM_DIR"
  unset PGPASSWORD PGUSER PGHOST PGDATABASE PGPORT PGSSLMODE S7_DB_URL S7_ADMIN_URL S7_PW_ENC
}
trap cleanup EXIT

# Literal (not regex) masking. The values reach perl through its own
# environment only (prefix assignment), so no other child inherits them.
mask() {
  S7_MASK_U="$PGUSER" S7_MASK_H="$PGHOST" S7_MASK_P="$PGPASSWORD" S7_MASK_PE="${S7_PW_ENC:-}" perl -pe 'BEGIN { @m = grep { defined && length } @ENV{qw(S7_MASK_P S7_MASK_PE S7_MASK_U S7_MASK_H)} }
            for my $v (@m) { s/\Q$v\E/[redacted]/g }'
}

IN=${1:-}
[ -n "$IN" ] && [ -d "$IN" ] || { say "usage: $0 <s6-restore-dir>"; exit 2; }
IN=$(cd "$IN" && pwd)

# ---------------------------------------------------------------- 0. inputs (no network)
shopt -s nullglob
S6_EVID=("$IN"/evidence-*.txt)
shopt -u nullglob
[ "${#S6_EVID[@]}" -eq 1 ] || { say "STOP: $IN must hold exactly one s6 evidence-*.txt"; exit 2; }
grep -q '^s6_ts=.* mode=remote ' "${S6_EVID[0]}" || { say "STOP: $IN is not a remote-mode s6 restore"; exit 2; }
grep -q '^S6_RESULT=PASS ' "${S6_EVID[0]}" || { say "STOP: the s6 evidence does not record S6_RESULT=PASS; verify or clean up the restore first"; exit 2; }
grep -q '^DATA REMAINS' "${S6_EVID[0]}" && { say "STOP: the s6 evidence records DATA REMAINS"; exit 2; }
[ -s "$IN/rowcounts-destination.txt" ] || { say "STOP: $IN/rowcounts-destination.txt is missing"; exit 2; }
for f in "$INVARIANTS_SQL" "$INTEGRITY_SQL" "$RLS_RUNNER"; do
  [ -s "$REPO/$f" ] || { say "STOP: $REPO/$f not found"; exit 2; }
done
[ -d "$MIGRATIONS_DIR" ] || { say "STOP: $MIGRATIONS_DIR not found"; exit 2; }
for tool in docker node npx openssl perl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { say "STOP: $tool is not available"; exit 2; }
done
docker version >/dev/null 2>&1 || { say "STOP: docker is not available"; exit 2; }
docker image inspect "$CLIENT_IMG" >/dev/null 2>&1 || { say "STOP: image $CLIENT_IMG is not present locally (do not pull now)"; exit 2; }

# ---------------------------------------------------------------- 1. identity, then password (no network before both pass)
read -r -p "Disposable project's session pooler host: " PGHOST
read -r -s -p "EXPECTED disposable project ref (not echoed): " EXPECTED_REF; say ""
read -r -s -p "PRODUCTION project ref, to refuse (not echoed): " PRODUCTION_REF; say ""
read -r -s -p "STAGING project ref, to refuse (not echoed): " STAGING_REF; say ""
read -r -s -p "Disposable project's database user (postgres.<ref>, not echoed): " PGUSER; say ""
REASON=$(validate_remote_target "$PGHOST" "$PGUSER" "$EXPECTED_REF" "$PRODUCTION_REF" "$STAGING_REF") \
  || { say "STOP: target identity rejected: $REASON"; exit 2; }
unset EXPECTED_REF PRODUCTION_REF STAGING_REF
say "Target identity: the connection user's project matches the expected disposable ref and is neither production nor staging."
read -r -s -p "Disposable project's database password (not echoed): " PGPASSWORD; say ""
[ -n "$PGPASSWORD" ] || { say "STOP: empty password"; exit 2; }
read -r -p "Type exactly '$CONFIRM_PHRASE' to continue: " CONFIRM
[ "$CONFIRM" = "$CONFIRM_PHRASE" ] || { say "STOP: confirmation phrase not given"; exit 2; }

PGDATABASE=$EXPECT_DB; PGPORT=5432; PGSSLMODE=require
export PGHOST PGUSER PGPASSWORD PGDATABASE PGPORT PGSSLMODE
# URLs are built in memory; the inputs reach node through its environment only.
build_url() {  # $1 = with-password | without-password
  S7_U="$PGUSER" S7_H="$PGHOST" S7_P="$PGPASSWORD" S7_WITH="$1" node -e '
    const u = new URL("postgresql://placeholder@placeholder:5432/postgres");
    u.username = encodeURIComponent(process.env.S7_U);
    u.hostname = process.env.S7_H;
    if (process.env.S7_WITH === "with-password") u.password = encodeURIComponent(process.env.S7_P);
    u.searchParams.set("sslmode", "require");
    process.stdout.write(u.toString());'
}
S7_DB_URL=$(build_url with-password) || { say "STOP: cannot build the connection URL"; exit 2; }
S7_ADMIN_URL=$(build_url without-password) || { say "STOP: cannot build the admin URL"; exit 2; }
S7_PW_ENC=$(S7_P="$PGPASSWORD" node -e 'process.stdout.write(encodeURIComponent(process.env.S7_P))')

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$IN/verify-$TS"
mkdir -p "$OUT" || { say "STOP: cannot create $OUT"; exit 2; }
EVID="$OUT/evidence-$TS.txt"
note "s7_ts=$TS s6_evidence=$(basename "${S6_EVID[0]}")"
note "target_identity=MATCH (user's project = expected disposable ref; not production, not staging)"

# ---------------------------------------------------------------- 2. client container (the only psql; no mounts, no ports)
STAGE=client
CLIENT="syveka-s7-client-$TS"
docker run -d --rm --name "$CLIENT" "$CLIENT_IMG" sleep infinity >/dev/null || stop "cannot start the client container"
# psql for this script and for run-rls-check.sh: runs in the client container,
# credentials from the environment (-e NAME copies the value, never as text);
# a file named with -f is streamed on stdin.
SHIM_DIR=$(mktemp -d "$OUT/.shim-XXXXXX") || stop "cannot create the psql shim directory"
cat > "$SHIM_DIR/psql" <<'SHIM'
#!/usr/bin/env bash
args=(); infile=''; stdin=0
while [ $# -gt 0 ]; do
  if [ "$1" = -f ] && [ "${2:-}" != - ]; then infile=$2; args+=(-f -); shift 2; continue; fi
  [ "$1" = -f ] && [ "${2:-}" = - ] && stdin=1
  args+=("$1"); shift
done
envs=(-e PGPASSWORD -e PGHOST -e PGUSER -e PGDATABASE -e PGPORT -e PGSSLMODE)
if [ -n "$infile" ]; then
  exec docker exec -i "${envs[@]}" "$S7_CLIENT" psql "${args[@]}" < "$infile"
fi
[ "$stdin" = 1 ] && exec docker exec -i "${envs[@]}" "$S7_CLIENT" psql "${args[@]}"
# No script on stdin: keep the caller's terminal input for its own prompts.
exec docker exec -i "${envs[@]}" "$S7_CLIENT" psql "${args[@]}" < /dev/null
SHIM
chmod 700 "$SHIM_DIR/psql"
export S7_CLIENT="$CLIENT"
export PATH="$SHIM_DIR:$PATH"
psql_dest() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

# ---------------------------------------------------------------- 3. destination guard (read-only)
STAGE=destination-guard
GUARD_SQL="select current_setting('server_version')
 ||'|'|| current_database()
 ||'|'|| (to_regclass('public._prisma_migrations') is not null)::int
 ||'|'|| (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p'))
 ||'|'|| coalesce((select count(*) from auth.users)::text, 'x')"
GUARD=$(psql_dest -At -c "$GUARD_SQL" 2> >(mask > "$OUT/guard-stderr.txt"))
GUARD_RC=$?
[ "$GUARD_RC" -eq 0 ] || { cat "$OUT/guard-stderr.txt"; stop "destination guard query failed (rc=$GUARD_RC); no data was read or written"; }
CONNECTED=1
IFS='|' read -r g_ver g_db g_prisma g_tables g_users <<< "$GUARD"
note "guard: version=$g_ver db=$g_db prisma_migrations_table=$g_prisma public_tables=$g_tables auth_users=$g_users"
case "$g_ver" in "$EXPECT_TARGET_VERSION_PREFIX"*) ;; *) stop "server_version $g_ver is not $EXPECT_TARGET_VERSION_PREFIX.x: not the disposable destination" ;; esac
[ "$g_db" = "$EXPECT_DB" ] || stop "unexpected database $g_db"
[ "$g_prisma" = 1 ] || stop "destination has no migration history: not a completed s6 restore"
[ "$g_tables" -gt 0 ] 2>/dev/null || stop "destination has no public tables: not a completed s6 restore"

# The same restored destination: row counts equal what s6 verified (the
# migration row may already be there on a repeat run; compared below).
psql_dest -At -F '|' -f "$ROWCOUNTS_SQL" > "$OUT/rowcounts-before.txt" 2> >(mask >> "$OUT/verify-stderr.txt") || stop "row counts failed"
diff <(grep '^rows|' "$IN/rowcounts-destination.txt" | grep -v '^rows|public\._prisma_migrations|' | sort) \
     <(grep '^rows|' "$OUT/rowcounts-before.txt" | grep -v '^rows|public\._prisma_migrations|' | sort) > "$OUT/rowcounts-before-diff.txt" \
  || { head -20 "$OUT/rowcounts-before-diff.txt" | tee -a "$EVID"; stop "row counts differ from the s6 restore: not the same destination, or it changed since"; }
note "guard=PASS rowcounts_vs_s6=MATCH"

# ---------------------------------------------------------------- 4. migration state, then the real prisma migrate deploy
STAGE=migration-state
history_state() {  # prints: <applied names file> state, one of PENDING | APPLIED | FAILED | OTHER
  psql_dest -At -c "select migration_name from public._prisma_migrations where finished_at is not null and rolled_back_at is null order by 1" \
    > "$OUT/migrations-applied-$1.txt" 2> >(mask >> "$OUT/verify-stderr.txt") || return 1
  UNFINISHED=$(psql_dest -At -c "select count(*) from public._prisma_migrations where finished_at is null or rolled_back_at is not null" 2> >(mask >> "$OUT/verify-stderr.txt")) || return 1
  PENDING=$(pending_migrations "$MIGRATIONS_DIR" "$OUT/migrations-applied-$1.txt" | tr '\n' ' ' | sed 's/ $//')
  if [ "$UNFINISHED" != 0 ]; then STATE=FAILED
  elif [ "$PENDING" = "$EXPECT_PENDING" ]; then STATE=PENDING
  elif [ -z "$PENDING" ] && grep -qx "$EXPECT_PENDING" "$OUT/migrations-applied-$1.txt"; then STATE=APPLIED
  else STATE=OTHER; fi
}
history_state before || stop "cannot read the migration history"
note "migration_history_before applied=$(grep -c '' "$OUT/migrations-applied-before.txt") unfinished=$UNFINISHED pending=${PENDING:-none} state=$STATE"
case "$STATE" in
  PENDING)
    read -r -p "Apply $EXPECT_PENDING to the disposable project with prisma migrate deploy? Type exactly '$MIGRATE_PHRASE': " MCONFIRM
    [ "$MCONFIRM" = "$MIGRATE_PHRASE" ] || stop "migration not authorized at run time; nothing was applied"
    STAGE=migrate-deploy
    note "migrate_deploy=STARTED $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ( cd "$REPO" && DATABASE_URL="$S7_DB_URL" DIRECT_URL="$S7_DB_URL" npx --no-install prisma migrate deploy ) 2>&1 | mask > "$OUT/migrate-deploy.txt"
    MIGRATE_RC=${PIPESTATUS[0]}
    note "migrate_deploy_rc=$MIGRATE_RC finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    [ "$MIGRATE_RC" -eq 0 ] || { tail -15 "$OUT/migrate-deploy.txt"; stop "prisma migrate deploy failed; the attempt stays recorded as Prisma left it (not resolved or retried here)"; }
    ;;
  APPLIED) note "migrate_deploy=SKIPPED (repeat run: $EXPECT_PENDING is already recorded as finished)" ;;
  FAILED) stop "the history has a failed or rolled-back migration; resolving it needs its own authorization" ;;
  *) stop "pending migrations '${PENDING:-none}' are not exactly '$EXPECT_PENDING'" ;;
esac

STAGE=verify-migration-history
( cd "$REPO" && DATABASE_URL="$S7_DB_URL" DIRECT_URL="$S7_DB_URL" npx --no-install prisma migrate status ) 2>&1 | mask > "$OUT/migrate-status.txt"
STATUS_RC=${PIPESTATUS[0]}
note "migrate_status_rc=$STATUS_RC"
[ "$STATUS_RC" -eq 0 ] && grep -q 'Database schema is up to date' "$OUT/migrate-status.txt" \
  || { tail -15 "$OUT/migrate-status.txt"; stop "prisma migrate status is not up to date"; }
history_state after || stop "cannot read the migration history"
note "migration_history_after applied=$(grep -c '' "$OUT/migrations-applied-after.txt") unfinished=$UNFINISHED pending=${PENDING:-none} state=$STATE"
[ "$STATE" = APPLIED ] || stop "after migrate deploy the history is $STATE, not APPLIED"

# ---------------------------------------------------------------- 5. release invariants (read-only)
STAGE=verify-invariants
( cd "$REPO" && psql_dest -f "$INVARIANTS_SQL" ) 2>&1 | mask > "$OUT/release-invariants.txt"
INV_RC=${PIPESTATUS[0]}
[ "$INV_RC" -eq 0 ] && grep -q 'ALL STAGING RELEASE INVARIANTS PASSED' "$OUT/release-invariants.txt" \
  || { tail -15 "$OUT/release-invariants.txt"; stop "release invariants failed (rc=$INV_RC)"; }
note "release_invariants=PASS"

# ---------------------------------------------------------------- 6. RLS suites (unchanged runner, staging-release.yml arguments)
run_rls() {  # $1 = role prefix, then the six files
  local prefix=$1; shift
  STAGE=verify-rls-$prefix
  ( cd "$REPO" && ADMIN_URL="$S7_ADMIN_URL" bash "$RLS_RUNNER" "$prefix" "$@" ) 2>&1 | grep -v '^::add-mask::' | mask > "$OUT/rls-$prefix.txt"
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] && grep -q 'ASSERTIONS PASSED' "$OUT/rls-$prefix.txt" && grep -q "^Cleanup verified: .* for $prefix\.\$" "$OUT/rls-$prefix.txt" \
    || { tail -15 "$OUT/rls-$prefix.txt"; stop "RLS suite $prefix failed (rc=$rc); an ephemeral role or fixtures may remain"; }
  note "rls_$prefix=PASS (assertions passed; cleanup verified)"
}
run_rls iso tests/rls/isolation-grants.sql tests/rls/isolation-revokes.sql tests/rls/isolation-fixtures.sql tests/rls/isolation-cleanup.sql tests/rls/isolation.sql tests/rls/isolation-grants-verify.sql
run_rls cal tests/rls/calendar-booking-grants.sql tests/rls/calendar-booking-revokes.sql tests/rls/calendar-booking-fixtures.sql tests/rls/calendar-booking-cleanup.sql tests/rls/calendar-booking-isolation.sql tests/rls/calendar-booking-grants-verify.sql
run_rls dna tests/rls/inbox-dna-grants.sql tests/rls/inbox-dna-revokes.sql tests/rls/inbox-dna-fixtures.sql tests/rls/inbox-dna-cleanup.sql tests/rls/inbox-dna-isolation.sql tests/rls/inbox-dna-grants-verify.sql

# ---------------------------------------------------------------- 7. tenant relationship integrity (one transaction, rolled back)
STAGE=verify-integrity
( cd "$REPO" && psql_dest -f "$INTEGRITY_SQL" ) 2>&1 | mask > "$OUT/tenant-integrity.txt"
INT_RC=${PIPESTATUS[0]}
[ "$INT_RC" -eq 0 ] || { tail -15 "$OUT/tenant-integrity.txt"; stop "tenant relationship integrity failed (rc=$INT_RC)"; }
note "tenant_integrity=PASS"

# ---------------------------------------------------------------- 8. row counts unchanged (fixtures gone; only the migration row added)
STAGE=verify-rowcounts
psql_dest -At -F '|' -f "$ROWCOUNTS_SQL" > "$OUT/rowcounts-after.txt" 2> >(mask >> "$OUT/verify-stderr.txt") || stop "row counts failed after verification"
diff <(grep '^rows|' "$OUT/rowcounts-before.txt" | grep -v '^rows|public\._prisma_migrations|' | sort) \
     <(grep '^rows|' "$OUT/rowcounts-after.txt" | grep -v '^rows|public\._prisma_migrations|' | sort) > "$OUT/rowcounts-after-diff.txt" \
  || { head -20 "$OUT/rowcounts-after-diff.txt" | tee -a "$EVID"; stop "row counts changed during verification (fixture residue?)"; }
note "rowcounts_after=MATCH (only _prisma_migrations may differ)"
note "S7_RESULT=PASS out=$OUT"
exit 0
