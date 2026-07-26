#!/usr/bin/env bash
# Runs a real-client RLS check through a dedicated, ephemeral LOGIN role instead
# of granting a temporary role to the administrative connection's own role and
# using SET ROLE. Hosted Postgres (Supabase) actively terminates the connection
# when the administrative role is granted an arbitrary role -- see the
# investigation notes in the PR this script was introduced by -- so the
# administrative connection here only ever creates the role, grants it
# privileges, loads fixtures, and later tears everything down; the actual RLS
# assertions run over a second, separate connection authenticated directly as
# that role, which never touches the administrative connection's own
# membership.
#
# Usage: run-rls-check.sh <role_prefix> <fixtures.sql> <cleanup.sql> <assertions.sql>
# Required env: ADMIN_URL (a full postgres:// connection URI with administrative
#   privileges -- never combined with a -d/-h flag anywhere in this script).
set -euo pipefail

role_prefix="$1"
fixtures_sql="$2"
cleanup_sql="$3"
assertions_sql="$4"

: "${ADMIN_URL:?ADMIN_URL is required}"

# A short, deterministic-per-run suffix keeps the role name valid (Postgres
# identifiers are limited to 63 bytes) and unique enough to avoid colliding
# with a concurrent run, without needing to expose or log anything.
run_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$-${RANDOM}${RANDOM}"
role_hash="$(printf '%s' "$run_suffix" | sha256sum | cut -c1-16)"
role_name="rls_${role_prefix}_${role_hash}"

password="$(openssl rand -hex 24)"
# Mask immediately, before any command that could echo it (GitHub Actions only;
# a harmless no-op outside Actions).
echo "::add-mask::${password}"

cleanup_ran=0
cleanup() {
  # Always attempt cleanup exactly once, on every exit path: normal completion,
  # an assertion failure, a client authentication failure, or a shell signal
  # (GitHub Actions still runs the trap when a step is interrupted).
  if [ "$cleanup_ran" = "1" ]; then
    return
  fi
  cleanup_ran=1
  local cleanup_status=0
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f "$cleanup_sql" >/dev/null || cleanup_status=1
  # Revoke exactly what was granted, using the administrative connection's own
  # authority as the original grantor. `DROP OWNED BY` is not enough on its own:
  # it requires the administrative role to be a MEMBER of the temporary role,
  # which this script deliberately never grants (that grant-to-self is exactly
  # the pattern a hosted Postgres provider can terminate the connection over --
  # see this file's header comment) -- so it is attempted only as a
  # best-effort extra, and the explicit revokes below are what cleanup
  # actually relies on.
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "revoke select, insert, update, delete on all tables in schema public from ${role_name}" >/dev/null 2>&1 || true
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "revoke usage on schema public from ${role_name}" >/dev/null 2>&1 || true
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "revoke authenticated from ${role_name}" >/dev/null 2>&1 || true
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "drop owned by ${role_name}" >/dev/null 2>&1 || true
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "drop role if exists ${role_name}" >/dev/null || cleanup_status=1

  local leftover
  leftover="$(psql "$ADMIN_URL" -Atqc "select count(*) from pg_roles where rolname = '${role_name}'")"
  if [ "$leftover" != "0" ]; then
    echo "Cleanup failed to remove role ${role_name}."
    cleanup_status=1
  fi

  if [ "$cleanup_status" != "0" ]; then
    echo "::error::RLS check cleanup for ${role_prefix} did not fully succeed -- see prior output."
    exit 1
  fi
  echo "Cleanup confirmed: no role, membership, or fixture residue remains for ${role_prefix}."
}
trap cleanup EXIT INT TERM

echo "Provisioning ephemeral LOGIN role for ${role_prefix} RLS check."
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "
  create role ${role_name} login password '${password}'
    nosuperuser nobypassrls nocreatedb nocreaterole noreplication inherit
"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "grant authenticated to ${role_name}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "grant usage on schema public to ${role_name}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "grant select, insert, update, delete on all tables in schema public to ${role_name}"

# Fixtures must commit (this script never wraps them in a transaction) so the
# separate client connection below, a different session entirely, can see them.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f "$fixtures_sql"

# Build the client connection URL entirely in memory. If the administrative
# connection uses a Supabase pooler's project-scoped username convention
# ("role.projectref"), reuse the same project-ref suffix for the new role;
# otherwise connect as the plain role name. Nothing here is printed.
ephemeral_url="$(
  ADMIN_URL="$ADMIN_URL" NEW_ROLE="$role_name" NEW_PASSWORD="$password" node -e '
    const { URL } = require("node:url");
    const u = new URL(process.env.ADMIN_URL);
    const adminUser = decodeURIComponent(u.username);
    const dotIndex = adminUser.indexOf(".");
    const newUser = dotIndex >= 0 ? process.env.NEW_ROLE + adminUser.slice(dotIndex) : process.env.NEW_ROLE;
    u.username = encodeURIComponent(newUser);
    u.password = encodeURIComponent(process.env.NEW_PASSWORD);
    process.stdout.write(u.toString());
  '
)"

# Test-only escape hatch (regression coverage H/I): deliberately connects with
# the wrong password, so the client-side login itself fails, to prove cleanup
# still removes the role with no residue even when the client never
# authenticates. Never set outside this script's own regression tests.
if [ -n "${RLS_CHECK_FORCE_LOGIN_FAILURE:-}" ]; then
  ephemeral_url="$(
    ADMIN_URL="$ephemeral_url" node -e '
      const { URL } = require("node:url");
      const u = new URL(process.env.ADMIN_URL);
      u.password = encodeURIComponent("deliberately-wrong-password");
      process.stdout.write(u.toString());
    '
  )"
fi

# Bounded retries guard only against newly-created-role propagation lag (e.g. a
# pooler's cached role list); any other failure -- wrong password, insufficient
# privilege, an unexpected role state -- fails immediately instead of retrying.
attempt=1
max_attempts=5
while true; do
  probe_err="$(psql "$ephemeral_url" -v ON_ERROR_STOP=1 -Atqc "select 1" 2>&1 1>/dev/null)" && break
  if [ "$attempt" -ge "$max_attempts" ] || ! printf '%s' "$probe_err" | grep -qi 'role ".*" does not exist'; then
    echo "::error::Ephemeral role ${role_name} failed to become usable (not a role-propagation-lag error)."
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "Running client-side RLS assertions as the ephemeral role for ${role_prefix}."
psql "$ephemeral_url" -v ON_ERROR_STOP=1 -f "$assertions_sql"
