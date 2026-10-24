#!/usr/bin/env bash
# Recovery drill §6/§7 (docs/recovery-drill-checklist.md): restore the
# SANITIZED archives written by s5-sanitize-offline.sh into an EMPTY,
# disposable Supabase project, then verify it.
#
# Usage: s6-restore-disposable.sh [--without-storage-metadata] <sanitized-dir>
#
# Modes:
#   remote    (default) the disposable project, through its session pooler.
#             Host, the expected disposable-project ref, the production and
#             staging refs (to refuse), user and password are typed at prompts
#             (never arguments; refs, user and password never echoed). The
#             user's project ref must equal the expected disposable ref and
#             differ from production and staging BEFORE the password is asked
#             and before any connection. Requires a separate, explicit §6
#             authorization.
#   localtest S6_MODE=localtest S6_LOCAL_CONTAINER=<name> for synthetic
#             rehearsals only: the "destination" is a local container that
#             must have --network none; commands run inside it over loopback.
#
# What is restored (the design under review; see README.md):
#   1. extensions the public schema references, if the destination lacks them;
#   2. public schema pre-data (tables, types, functions), owners normalized to
#      the connecting role (--no-owner), grants kept;
#   3. DATA ONLY for auth.users, auth.identities, storage.buckets,
#      storage.objects (the destination's Auth/Storage own the definitions);
#   4. public data, then public post-data (constraints, indexes, policies,
#      triggers), then the application's on_auth_user_created trigger.
# All of it runs in ONE psql transaction: an error DURING the restore rolls
# back and leaves the destination exactly as it was. A failure AFTER the
# commit (verification) leaves restored data behind: the script then prints
# "DATA REMAINS — OWNER CLEANUP REQUIRED" with the failed stage, and never
# deletes anything itself. Before any write, the destination must prove it is
# the expected empty target (version, no migration history, no Auth users, no
# Storage rows, no public relations). Migrations are NOT applied here.
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
CHECKS_SQL="$HERE/sanitize-checks.sql"
SCRUB_SQL="$HERE/scrub-functions.sql"
EXPECTED_CHECKS="$HERE/expected-checks.txt"
ROWCOUNTS_SQL="$HERE/rowcounts.sql"
PRIVILEGES_SQL="$HERE/privileges.sql"
PRELUDE_SQL="$HERE/destination-prelude.sql"
MIGRATIONS_DIR="$REPO/prisma/migrations"

say() { printf '%s\n' "$*"; }
EVID=''
COMMITTED=0
STAGE=preflight
note() { say "$*"; [ -n "$EVID" ] && printf '%s\n' "$*" >> "$EVID"; }
stop() {
  note "S6_RESULT=STOP stage=$STAGE reason: $*"
  if [ "$COMMITTED" = 1 ]; then
    note "DATA REMAINS — OWNER CLEANUP REQUIRED (failed stage: $STAGE). The restore was committed; the destination now holds sanitized data. Nothing was deleted automatically."
  fi
  exit 1
}

CLIENT=''; OWN_CLIENT=0
cleanup() {
  [ "$OWN_CLIENT" = 1 ] && [ -n "$CLIENT" ] && docker rm -f "$CLIENT" >/dev/null 2>&1
  unset PGPASSWORD PGUSER PGHOST
}
trap cleanup EXIT

INCLUDE_STORAGE=1
if [ "${1:-}" = "--without-storage-metadata" ]; then INCLUDE_STORAGE=0; shift; fi
IN=${1:-}
[ -n "$IN" ] && [ -d "$IN" ] || { say "usage: $0 [--without-storage-metadata] <sanitized-dir>"; exit 2; }
IN=$(cd "$IN" && pwd)
MODE=${S6_MODE:-remote}

# ---------------------------------------------------------------- 0. inputs
shopt -s nullglob
SUMS=("$IN"/SHA256SUMS-*.txt)
shopt -u nullglob
[ "${#SUMS[@]}" -eq 1 ] || { say "STOP: $IN must hold exactly one SHA256SUMS-*.txt"; exit 2; }
for f in sanitized-public.dump sanitized-managed.dump rowcounts-sanitized.txt privileges-sanitized.txt checks-sanitized.txt; do
  [ -s "$IN/$f" ] || { say "STOP: $IN/$f is missing"; exit 2; }
done
( cd "$IN" && sha256sum -c "$(basename "${SUMS[0]}")" >/dev/null 2>&1 ) || { say "STOP: archives do not match their checksums"; exit 2; }
validate_checks "$EXPECTED_CHECKS" "$IN/checks-sanitized.txt" >/dev/null \
  || { say "STOP: the s5 checks recorded with these archives do not pass"; exit 2; }
[ -d "$MIGRATIONS_DIR" ] || { say "STOP: $MIGRATIONS_DIR not found"; exit 2; }
docker version >/dev/null 2>&1 || { say "STOP: docker is not available"; exit 2; }

# ---------------------------------------------------------------- 1. destination and client context
if [ "$MODE" = localtest ]; then
  CLIENT=${S6_LOCAL_CONTAINER:?S6_LOCAL_CONTAINER is required in localtest mode}
  [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CLIENT" 2>/dev/null)" = none ] \
    || { say "STOP: localtest destination must be a running container with --network none"; exit 2; }
  PGHOST=localhost; PGUSER=postgres
  : "${PGPASSWORD:?PGPASSWORD (the synthetic container password) is required in localtest mode}"
  EXPECT_TARGET_VERSION_PREFIX=${S6_EXPECT_VERSION_PREFIX:-$EXPECT_TARGET_VERSION_PREFIX}
  CONFIRM_PHRASE='RESTORE LOCAL TEST'; CONFIRM=${S6_CONFIRM:-}
elif [ "$MODE" = remote ]; then
  docker image inspect "$CLIENT_IMG" >/dev/null 2>&1 || { say "STOP: image $CLIENT_IMG is not present locally (do not pull now)"; exit 2; }
  read -r -p "Disposable project's session pooler host: " PGHOST
  read -r -s -p "EXPECTED disposable project ref (not echoed): " EXPECTED_REF; say ""
  read -r -s -p "PRODUCTION project ref, to refuse (not echoed): " PRODUCTION_REF; say ""
  read -r -s -p "STAGING project ref, to refuse (not echoed): " STAGING_REF; say ""
  read -r -s -p "Disposable project's database user (postgres.<ref>, not echoed): " PGUSER; say ""
  # Identity before any password or connection (lib.sh validate_remote_target).
  REASON=$(validate_remote_target "$PGHOST" "$PGUSER" "$EXPECTED_REF" "$PRODUCTION_REF" "$STAGING_REF") \
    || { say "STOP: target identity rejected: $REASON"; exit 2; }
  unset EXPECTED_REF PRODUCTION_REF STAGING_REF
  say "Target identity: the connection user's project matches the expected disposable ref and is neither production nor staging."
  read -r -s -p "Disposable project's database password (not echoed): " PGPASSWORD; say ""
  [ -n "$PGPASSWORD" ] || { say "STOP: empty password"; exit 2; }
  CONFIRM_PHRASE='RESTORE TO DISPOSABLE'
  read -r -p "Type exactly '$CONFIRM_PHRASE' to continue: " CONFIRM
else
  say "STOP: S6_MODE must be remote or localtest"; exit 2
fi
export PGPASSWORD
[ "$CONFIRM" = "$CONFIRM_PHRASE" ] || { say "STOP: confirmation phrase not given"; exit 2; }

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$IN/restore-$MODE-$TS"
mkdir -p "$OUT" || { say "STOP: cannot create $OUT"; exit 2; }
EVID="$OUT/evidence-$TS.txt"
note "s6_ts=$TS mode=$MODE include_storage_metadata=$INCLUDE_STORAGE"
[ "$MODE" = remote ] && note "target_identity=MATCH (user's project = expected disposable ref; not production, not staging)"
STAGE=destination-guard

if [ "$MODE" = remote ]; then
  CLIENT="syveka-s6-client-$TS"; OWN_CLIENT=1
  # The only container with network access; it receives sanitized archives only.
  docker run -d --rm --name "$CLIENT" -e PGPASSWORD "$CLIENT_IMG" sleep infinity >/dev/null || stop "cannot start the client container"
fi
in_client() { docker exec -i -e PGPASSWORD "$CLIENT" "$@"; }
put() { in_client sh -c "umask 077; cat > '$2'" < "$1"; }
psql_dest() { in_client psql -X -q -v ON_ERROR_STOP=1 -h "$PGHOST" -p 5432 -U "$PGUSER" -d "$EXPECT_DB" "$@"; }
mask() {
  local u h
  u=$(printf '%s' "$PGUSER" | sed 's/[.[\*^$]/\\&/g'); h=$(printf '%s' "$PGHOST" | sed 's/[.[\*^$]/\\&/g')
  sed -e "s/$u/[db-user]/g" -e "s/$h/[db-host]/g"
}

# ---------------------------------------------------------------- 2. destination guard (read-only, before any write)
GUARD_SQL="select current_setting('server_version')
 ||'|'|| current_database()
 ||'|'|| (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f'))
 ||'|'|| (to_regclass('public._prisma_migrations') is not null)::int
 ||'|'|| coalesce((select count(*) from auth.users)::text, 'x')
 ||'|'|| coalesce((select count(*) from storage.buckets)::text, 'x')
 ||'|'|| coalesce((select count(*) from storage.objects)::text, 'x')"
GUARD=$(psql_dest -At -c "$GUARD_SQL" 2> "$OUT/guard-stderr.txt")
GUARD_RC=$?
mask < "$OUT/guard-stderr.txt" > "$OUT/guard-stderr.masked.txt"; rm -f "$OUT/guard-stderr.txt"
[ "$GUARD_RC" -eq 0 ] || { cat "$OUT/guard-stderr.masked.txt"; stop "destination guard query failed (rc=$GUARD_RC)"; }
IFS='|' read -r g_ver g_db g_public g_prisma g_users g_buckets g_objects <<< "$GUARD"
note "guard: version=$g_ver db=$g_db public_relations=$g_public prisma_migrations_table=$g_prisma auth_users=$g_users storage_buckets=$g_buckets storage_objects=$g_objects"
case "$g_ver" in "$EXPECT_TARGET_VERSION_PREFIX"*) ;; *) stop "server_version $g_ver is not $EXPECT_TARGET_VERSION_PREFIX.x: not the disposable destination" ;; esac
[ "$g_db" = "$EXPECT_DB" ] || stop "unexpected database $g_db"
# Specific guards first, so each refusal names what was found.
[ "$g_prisma" = 0 ] || stop "destination already has a migration history"
[ "$g_users" = 0 ] || stop "destination already has $g_users Auth user(s)"
[ "$g_buckets" = 0 ] && [ "$g_objects" = 0 ] || stop "destination already has Storage rows"
[ "$g_public" = 0 ] || stop "destination is not empty: $g_public relation(s) in public"
note "guard=PASS"
STAGE=build-restore

# ---------------------------------------------------------------- 3. build the restore (rendered in the client context)
put "$IN/sanitized-public.dump" /tmp/public.dump || stop "cannot stage the public archive"
put "$IN/sanitized-managed.dump" /tmp/managed.dump || stop "cannot stage the managed archive"
in_client pg_restore -l /tmp/public.dump > "$OUT/public-listing.txt" || stop "public archive unreadable"
in_client pg_restore -l /tmp/managed.dump > "$OUT/managed-listing.txt" || stop "managed archive unreadable"
toc_select_public < "$OUT/public-listing.txt" > "$OUT/public.list"
toc_select_managed_data "$INCLUDE_STORAGE" < "$OUT/managed-listing.txt" > "$OUT/managed-data.list"
toc_select_auth_trigger < "$OUT/managed-listing.txt" > "$OUT/auth-trigger.list"
note "entries public=$(grep -c '' "$OUT/public.list") managed_data=$(toc_body < "$OUT/managed-data.list" | awk '{print $3 "." $4}' | tr '\n' ' ') auth_trigger=$(grep -c '' "$OUT/auth-trigger.list")"
grep -q 'auth users' "$OUT/managed-data.list" || stop "the managed archive has no auth.users data"
note "skipped_platform_default_acls=$(toc_body < "$OUT/public-listing.txt" | grep -E '^DEFAULT ACL public ' | awk '$NF != "postgres" {print $NF "/" $(NF-1)}' | tr '\n' ' ')"
NON_POSTGRES_OWNERS=$(toc_body < "$OUT/public.list" | awk '{print $NF}' | sort -u | grep -vx postgres | tr '\n' ' ')
note "public_owners_other_than_postgres=${NON_POSTGRES_OWNERS:-none} (normalized to the connecting role by --no-owner)"
for l in public.list managed-data.list auth-trigger.list; do put "$OUT/$l" "/tmp/$l" || stop "cannot stage $l"; done

EXTS=$(in_client pg_restore -s -f - /tmp/public.dump | detect_extensions) || stop "extension detection failed: $EXTS"
cp "$PRELUDE_SQL" "$OUT/00-extensions.sql"
while read -r ext sch; do
  [ -n "$ext" ] || continue
  # < /dev/null: docker exec -i would otherwise consume the rest of this loop's input.
  have=$(psql_dest -At -c "select coalesce((select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = '$ext'), '-')" < /dev/null)
  if [ "$have" = "$sch" ]; then note "extension $ext present in $sch"
  elif [ "$have" = - ]; then note "extension $ext will be created in $sch"; printf 'create extension if not exists "%s" with schema %s;\n' "$ext" "$sch" >> "$OUT/00-extensions.sql"
  else stop "extension $ext is installed in $have, the archive expects $sch"
  fi
done <<< "$EXTS"
put "$OUT/00-extensions.sql" /tmp/00-extensions.sql || stop "cannot stage the extension prelude"

render() { in_client pg_restore --no-owner "$@" 2>> "$OUT/render-stderr.txt"; }
render -L /tmp/public.list --section=pre-data -f /tmp/10-public-pre.sql /tmp/public.dump || stop "cannot render public pre-data"
render -L /tmp/managed-data.list -f /tmp/20-managed-data.sql /tmp/managed.dump || stop "cannot render the managed table data"
render -L /tmp/public.list --section=data -f /tmp/30-public-data.sql /tmp/public.dump || stop "cannot render public data"
render -L /tmp/public.list --section=post-data -f /tmp/40-public-post.sql /tmp/public.dump || stop "cannot render public post-data"
render -L /tmp/auth-trigger.list -f /tmp/50-auth-trigger.sql /tmp/managed.dump || stop "cannot render the auth trigger"

# ---------------------------------------------------------------- 4. restore: one transaction
STAGE=restore
START=$(date -u +%s); START_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
psql_dest --single-transaction -f /tmp/00-extensions.sql -f /tmp/10-public-pre.sql -f /tmp/20-managed-data.sql \
  -f /tmp/30-public-data.sql -f /tmp/40-public-post.sql -f /tmp/50-auth-trigger.sql \
  > /dev/null 2> "$OUT/restore-stderr.txt"
RC=$?
END_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mask < "$OUT/restore-stderr.txt" > "$OUT/restore-stderr.masked.txt"; rm -f "$OUT/restore-stderr.txt"
in_client rm -f /tmp/10-public-pre.sql /tmp/20-managed-data.sql /tmp/30-public-data.sql /tmp/40-public-post.sql /tmp/50-auth-trigger.sql
note "restore_rc=$RC restore_started_utc=$START_UTC restore_finished_utc=$END_UTC time_to_restore_seconds=$(( $(date -u +%s) - START ))"
if [ "$RC" -ne 0 ]; then
  tail -5 "$OUT/restore-stderr.masked.txt"
  stop "RESTORE ROLLED BACK: the single restore transaction failed, so nothing was committed and the destination is unchanged (if the connection itself was lost, confirm the destination is still empty before any retry)"
fi
COMMITTED=1
note "restore_committed=yes (from here on, any failure leaves restored data in the destination)"

# ---------------------------------------------------------------- 5. verify the destination (post-commit)
STAGE=verify-checks
put "$SCRUB_SQL" /tmp/scrub-functions.sql && put "$CHECKS_SQL" /tmp/sanitize-checks.sql && put "$ROWCOUNTS_SQL" /tmp/rowcounts.sql \
  && put "$PRIVILEGES_SQL" /tmp/privileges.sql || stop "cannot stage the verification SQL"
psql_dest -At -F '|' -f /tmp/scrub-functions.sql -f /tmp/sanitize-checks.sql > "$OUT/checks-destination.txt" 2>> "$OUT/verify-stderr.txt" \
  || stop "checks failed on the destination (SQL error)"
validate_checks "$EXPECTED_CHECKS" "$OUT/checks-destination.txt" > "$OUT/checks-destination-verdict.txt" \
  || { cat "$OUT/checks-destination-verdict.txt" | tee -a "$EVID"; stop "forbidden data on the destination"; }
note "checks_destination=PASS"

STAGE=verify-rowcounts
psql_dest -At -F '|' -f /tmp/rowcounts.sql > "$OUT/rowcounts-destination.txt" 2>> "$OUT/verify-stderr.txt" || stop "row counts failed on the destination"
EXPECTED_ROWS="$OUT/rowcounts-expected.txt"
if [ "$INCLUDE_STORAGE" = 1 ]; then cp "$IN/rowcounts-sanitized.txt" "$EXPECTED_ROWS"
else grep -vE '^rows\|storage\.' "$IN/rowcounts-sanitized.txt" > "$EXPECTED_ROWS"; grep -vE '^rows\|storage\.' "$OUT/rowcounts-destination.txt" > "$OUT/rowcounts-destination.cmp"; mv "$OUT/rowcounts-destination.cmp" "$OUT/rowcounts-destination.txt"
fi
compare_rowcounts "$EXPECTED_ROWS" "$OUT/rowcounts-destination.txt" > "$OUT/rowcounts-diff.txt" \
  || { cat "$OUT/rowcounts-diff.txt" | tee -a "$EVID"; stop "destination row counts differ from the sanitized source"; }
note "rowcounts=MATCH ($(grep -c '^rows|' "$EXPECTED_ROWS") tables)"

STAGE=verify-privileges
psql_dest -At -F '|' -f /tmp/privileges.sql > "$OUT/privileges-destination.txt" 2>> "$OUT/verify-stderr.txt" || stop "privilege fingerprint failed on the destination"
diff "$IN/privileges-sanitized.txt" "$OUT/privileges-destination.txt" > "$OUT/privileges-diff.txt" \
  || { head -20 "$OUT/privileges-diff.txt" | tee -a "$EVID"; stop "destination grants or postgres's public default privileges differ from the source (see privileges-diff.txt)"; }
note "privileges=MATCH ($(grep -c '^acl|' "$OUT/privileges-destination.txt") grants on public objects, of which $(grep -c '^acl|default:' "$OUT/privileges-destination.txt") are postgres's public default privileges)"

STAGE=verify-auth-trigger
if [ -s "$OUT/auth-trigger.list" ]; then
  [ "$(psql_dest -At -c "select count(*) from pg_trigger where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass")" = 1 ] \
    || stop "on_auth_user_created is missing on the destination"
  note "auth_trigger=present"
fi

STAGE=verify-migration-history
psql_dest -At -c "select migration_name from public._prisma_migrations where finished_at is not null and rolled_back_at is null order by 1" \
  > "$OUT/migrations-applied.txt" || stop "cannot read the migration history"
UNFINISHED=$(psql_dest -At -c "select count(*) from public._prisma_migrations where finished_at is null or rolled_back_at is not null")
PENDING=$(pending_migrations "$MIGRATIONS_DIR" "$OUT/migrations-applied.txt" | tr '\n' ' ' | sed 's/ $//')
note "migration_history applied=$(grep -c '' "$OUT/migrations-applied.txt") unfinished=$UNFINISHED pending_at_this_commit=${PENDING:-none}"
[ "$UNFINISHED" = 0 ] || stop "the restored history has unfinished or rolled-back migrations"
[ "$PENDING" = "$EXPECT_PENDING" ] || stop "pending migrations '${PENDING:-none}' are not exactly '$EXPECT_PENDING'"
note "S6_RESULT=PASS out=$OUT (migration $EXPECT_PENDING is pending; applying it is a separate, separately authorized step)"
exit 0
