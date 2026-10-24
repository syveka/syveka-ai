#!/usr/bin/env bash
# Recovery drill §5 (docs/recovery-drill-checklist.md): sanitize a §4 logical
# dump OFFLINE and write the sanitized archives that §6 may restore.
#
# Usage: s5-sanitize-offline.sh <dump-dir>
#   <dump-dir> holds what the §4 dump step wrote: roles-<TS>.sql,
#   syveka-<prefix>-<TS>.dump and SHA256SUMS-<TS>.txt. Output goes to a new
#   <dump-dir>/sanitized-<UTC>/ directory.
#
# Isolation:
#   * one throwaway pgvector/pgvector:pg17 container, --network none, no
#     published ports, no bind mounts, memory-capped, removed on every exit;
#   * files enter and leave only as byte streams over `docker exec -i`;
#   * nothing here connects to any remote database or needs a credential.
# Fails closed: any SQL error, any missing/duplicated/unknown check, or any
# non-zero forbidden-data count stops the run before a sanitized archive is
# written. Evidence files hold counts, object names and checksums only.
set -uo pipefail
umask 077
export MSYS_NO_PATHCONV=1

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

IMG=pgvector/pgvector:pg17
MEMORY_LIMIT=1g
SANITIZE_SQL="$HERE/sanitize.sql"
CHECKS_SQL="$HERE/sanitize-checks.sql"
EXPECTED_CHECKS="$HERE/expected-checks.txt"
ROWCOUNTS_SQL="$HERE/rowcounts.sql"
PRIVILEGES_SQL="$HERE/privileges.sql"

say() { printf '%s\n' "$*"; }
EVID=''
note() { say "$*"; [ -n "$EVID" ] && printf '%s\n' "$*" >> "$EVID"; }
stop() { note "S5_RESULT=STOP reason: $*"; exit 1; }

CTR=''
cleanup() { [ -n "$CTR" ] && docker rm -f "$CTR" >/dev/null 2>&1; }
trap cleanup EXIT

# ---------------------------------------------------------------- 0. preconditions
SRC=${1:-}
[ -n "$SRC" ] && [ -d "$SRC" ] || { say "usage: $0 <dump-dir>"; exit 2; }
SRC=$(cd "$SRC" && pwd)
for f in "$SANITIZE_SQL" "$CHECKS_SQL" "$EXPECTED_CHECKS" "$ROWCOUNTS_SQL" "$PRIVILEGES_SQL"; do
  [ -s "$f" ] || { say "STOP: $f is missing"; exit 2; }
done
docker version >/dev/null 2>&1 || { say "STOP: docker is not available"; exit 2; }
docker image inspect "$IMG" >/dev/null 2>&1 || { say "STOP: image $IMG is not present locally (do not pull now)"; exit 2; }

shopt -s nullglob
ROLES=("$SRC"/roles-*.sql); DUMPS=("$SRC"/syveka-*.dump); SUMS=("$SRC"/SHA256SUMS-*.txt)
shopt -u nullglob
[ "${#ROLES[@]}" -eq 1 ] && [ "${#DUMPS[@]}" -eq 1 ] && [ "${#SUMS[@]}" -eq 1 ] \
  || { say "STOP: $SRC must hold exactly one roles-*.sql, syveka-*.dump and SHA256SUMS-*.txt"; exit 2; }
( cd "$SRC" && sha256sum -c "$(basename "${SUMS[0]}")" >/dev/null 2>&1 ) \
  || { say "STOP: the dump files do not match $(basename "${SUMS[0]}")"; exit 2; }
grep -q PASSWORD "${ROLES[0]}" && { say "STOP: the roles file contains PASSWORD lines"; exit 2; }

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$SRC/sanitized-$TS"
[ -e "$OUT" ] && { say "STOP: $OUT already exists"; exit 2; }
mkdir -p "$OUT" || { say "STOP: cannot create $OUT"; exit 2; }
EVID="$OUT/evidence-$TS.txt"
note "s5_ts=$TS image=$IMG input=$(basename "${DUMPS[0]}") input_sha256_verified=yes"

# ---------------------------------------------------------------- 1. isolated container
CTR="syveka-s5-$TS"
PW=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
docker run -d --rm --name "$CTR" --network none --memory "$MEMORY_LIMIT" \
  -e POSTGRES_PASSWORD="$PW" "$IMG" >/dev/null || stop "cannot start $IMG"
unset PW
NET=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CTR")
PORTS=$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$CTR")
MOUNTS=$(docker inspect -f '{{len .HostConfig.Binds}}' "$CTR")
note "container network=$NET published_ports=$PORTS bind_mounts=$MOUNTS"
[ "$NET" = none ] && [ "$PORTS" = 0 ] && [ "$MOUNTS" = 0 ] || stop "container is not isolated"
for _ in $(seq 1 60); do
  docker exec "$CTR" pg_isready -q -U postgres 2>/dev/null && break
  sleep 1
done
docker exec "$CTR" pg_isready -q -U postgres || stop "postgres did not start"
# The entrypoint restarts the server once after initdb; wait for the final one.
sleep 3
docker exec "$CTR" pg_isready -q -U postgres || stop "postgres did not stay up"

in_ctr() { docker exec -i "$CTR" "$@"; }
put() { in_ctr sh -c "umask 077; cat > '$2'" < "$1"; }
psql_ctr() { in_ctr psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }

put "${DUMPS[0]}" /tmp/raw.dump || stop "cannot stage the dump"
put "${ROLES[0]}" /tmp/roles.sql || stop "cannot stage the roles file"
for f in "$SANITIZE_SQL" "$CHECKS_SQL" "$ROWCOUNTS_SQL" "$PRIVILEGES_SQL"; do
  put "$f" "/tmp/$(basename "$f")" || stop "cannot stage $(basename "$f")"
done

# ---------------------------------------------------------------- 2. restore the raw dump (one transaction)
in_ctr pg_restore -l /tmp/raw.dump > "$OUT/raw-listing.txt" 2>> "$EVID" || stop "pg_restore --list failed on the raw dump"
toc_select_all_but_public_schema < "$OUT/raw-listing.txt" > "$OUT/raw-restore.list"
note "raw_entries=$(grep -c '^[0-9]' "$OUT/raw-listing.txt") restored_entries=$(grep -c '' "$OUT/raw-restore.list")"
note "raw_auth_table_data=$(toc_body < "$OUT/raw-listing.txt" | grep -E '^TABLE DATA auth ' | awk '{print $4}' | sort | tr '\n' ' ')"
put "$OUT/raw-restore.list" /tmp/raw-restore.list || stop "cannot stage the restore list"

EXTS=$(in_ctr pg_restore -s -f - /tmp/raw.dump | detect_extensions) || stop "extension detection failed: $EXTS"
note "extensions_referenced=$(printf '%s' "$EXTS" | tr '\n' ',')"
{
  # Supabase creates its roles before any schema; the dump's own roles file
  # recreates them here (no passwords). postgres is this server's bootstrap
  # superuser, so its CREATE and attribute lines are skipped.
  printf 'set client_min_messages = warning;\n'
  printf '%s\n' "$EXTS" | while read -r ext sch; do
    [ -n "$ext" ] || continue
    printf 'create schema if not exists %s;\ncreate extension if not exists "%s" with schema %s;\n' "$sch" "$ext" "$sch"
  done
} > "$OUT/prelude.sql"
put "$OUT/prelude.sql" /tmp/prelude.sql || stop "cannot stage the prelude"
# Memberships keep their grantee and options but drop "GRANTED BY": the
# grantor is irrelevant in this throwaway copy, and PostgreSQL 16+ refuses
# grants recorded as made by a role without ADMIN OPTION.
in_ctr sh -c "grep -vE '^(CREATE ROLE postgres;|ALTER ROLE postgres WITH )' /tmp/roles.sql | sed -E '/^GRANT /s/ GRANTED BY [^;]+;\$/;/' > /tmp/roles-filtered.sql" \
  || stop "cannot filter the roles file"
in_ctr pg_restore -L /tmp/raw-restore.list -f /tmp/raw.sql /tmp/raw.dump 2>> "$EVID" || stop "pg_restore could not render the raw dump"
RESTORE_START=$(date -u +%s)
psql_ctr --single-transaction -f /tmp/roles-filtered.sql -f /tmp/prelude.sql -f /tmp/raw.sql \
  > /dev/null 2> "$OUT/raw-restore-stderr.txt" || { tail -5 "$OUT/raw-restore-stderr.txt"; stop "raw restore failed (rolled back); see raw-restore-stderr.txt"; }
note "raw_restore_seconds=$(( $(date -u +%s) - RESTORE_START ))"
in_ctr rm -f /tmp/raw.sql

# ---------------------------------------------------------------- 3. counts before sanitizing
psql_ctr -At -F '|' -f /tmp/sanitize-checks.sql > "$OUT/checks-raw.txt" 2>> "$EVID" || stop "checks failed on the raw restore (SQL error)"
validate_checks "$EXPECTED_CHECKS" "$OUT/checks-raw.txt" complete >> "$EVID" || stop "the check output before sanitizing is incomplete"
psql_ctr -At -F '|' -f /tmp/rowcounts.sql > "$OUT/rowcounts-raw.txt" 2>> "$EVID" || stop "row counts failed on the raw restore"
note "raw_nonzero_checks=$(awk -F'|' '$3 ~ /^[1-9]/ {printf "%s=%s ", $2, $3}' "$OUT/checks-raw.txt")"

# ---------------------------------------------------------------- 4. sanitize (one transaction) and verify
psql_ctr --single-transaction -f /tmp/sanitize.sql > /dev/null 2> "$OUT/sanitize-stderr.txt" \
  || { tail -5 "$OUT/sanitize-stderr.txt"; stop "sanitize.sql failed (rolled back)"; }
psql_ctr -At -F '|' -f /tmp/sanitize-checks.sql > "$OUT/checks-sanitized.txt" 2>> "$EVID" || stop "checks failed after sanitizing (SQL error)"
if ! validate_checks "$EXPECTED_CHECKS" "$OUT/checks-sanitized.txt" > "$OUT/checks-sanitized-verdict.txt"; then
  cat "$OUT/checks-sanitized-verdict.txt" | tee -a "$EVID"
  stop "forbidden data remains after sanitizing; no sanitized archive written"
fi
note "checks_sanitized=PASS ($(grep -c '^check|' "$OUT/checks-sanitized.txt") checks)"
psql_ctr -At -F '|' -f /tmp/rowcounts.sql > "$OUT/rowcounts-sanitized.txt" 2>> "$EVID" || stop "row counts failed after sanitizing"
psql_ctr -At -F '|' -f /tmp/privileges.sql > "$OUT/privileges-sanitized.txt" 2>> "$EVID" || stop "privilege fingerprint failed"
note "privilege_grants_recorded=$(grep -c '^acl|' "$OUT/privileges-sanitized.txt")"

# ---------------------------------------------------------------- 5. sanitized archives (stdout -> host)
HAS_IDENTITIES=$(psql_ctr -At -c "select to_regclass('auth.identities') is not null")
MANAGED="-t auth.users -t storage.buckets -t storage.objects"
[ "$HAS_IDENTITIES" = t ] && MANAGED="$MANAGED -t auth.identities"
# shellcheck disable=SC2086
in_ctr pg_dump -Fc --strict-names $MANAGED -U postgres -d postgres > "$OUT/sanitized-managed.dump" 2>> "$EVID" \
  || stop "pg_dump of the managed tables failed"
in_ctr pg_dump -Fc -n public -U postgres -d postgres > "$OUT/sanitized-public.dump" 2>> "$EVID" \
  || stop "pg_dump of the public schema failed"

in_ctr pg_restore -l < "$OUT/sanitized-public.dump" > "$OUT/sanitized-public-listing.txt" 2>> "$EVID" || stop "sanitized public archive unreadable"
in_ctr pg_restore -l < "$OUT/sanitized-managed.dump" > "$OUT/sanitized-managed-listing.txt" 2>> "$EVID" || stop "sanitized managed archive unreadable"
RAW_PUBLIC_TABLES=$(toc_body < "$OUT/raw-listing.txt" | grep -cE '^TABLE public ')
OUT_PUBLIC_TABLES=$(toc_body < "$OUT/sanitized-public-listing.txt" | grep -cE '^TABLE public ')
OUT_MANAGED_DATA=$(toc_body < "$OUT/sanitized-managed-listing.txt" | grep -E '^TABLE DATA ' | awk '{print $3 "." $4}' | sort | tr '\n' ' ')
note "public_tables raw=$RAW_PUBLIC_TABLES sanitized=$OUT_PUBLIC_TABLES managed_table_data=$OUT_MANAGED_DATA"
[ "$RAW_PUBLIC_TABLES" = "$OUT_PUBLIC_TABLES" ] || stop "the sanitized public archive lost tables"
toc_body < "$OUT/sanitized-public-listing.txt" | grep -qE '^TABLE public _prisma_migrations ' || stop "the sanitized archive has no _prisma_migrations"
toc_body < "$OUT/sanitized-managed-listing.txt" | grep -E '^TABLE DATA ' \
  | grep -vqE '^TABLE DATA (auth (users|identities)|storage (buckets|objects)) ' \
  && stop "the managed archive carries a table other than auth.users/identities, storage.buckets/objects"

( cd "$OUT" && sha256sum sanitized-public.dump sanitized-managed.dump rowcounts-sanitized.txt privileges-sanitized.txt checks-sanitized.txt >"SHA256SUMS-$TS.txt" ) \
  || stop "cannot write checksums"
cat "$OUT/SHA256SUMS-$TS.txt" >> "$EVID"
note "S5_RESULT=PASS out=$OUT"
exit 0
