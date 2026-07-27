#!/usr/bin/env bash
# Runs a real-client RLS check through a dedicated, ephemeral LOGIN role instead
# of granting a temporary role to the administrative connection's own role and
# using SET ROLE. Hosted Postgres providers can terminate a connection outright
# when its own role is granted a new role -- confirmed by the exact staging
# failure this script was introduced to fix (the connection died precisely at
# that GRANT, never reaching SET ROLE). The administrative connection here
# only ever creates the role, grants it an explicit, per-suite privilege
# allowlist, loads fixtures, and later tears everything down; the actual RLS
# assertions run over a second, separate connection authenticated directly as
# that role, which never touches the administrative connection's own
# membership.
#
# Usage: run-rls-check.sh <role_prefix> <grants.sql> <revokes.sql> \
#          <fixtures.sql> <cleanup.sql> <assertions.sql> <grants-verify.sql>
# Required env: ADMIN_URL (a full postgres:// connection URI with administrative
#   privileges -- never combined with a -d/-h flag anywhere in this script).
#
# Cleanup guarantee: the EXIT/INT/TERM trap below runs on every path this
# script can itself observe -- successful completion, an assertion failure, a
# client authentication failure, or an ordinary interrupt (GitHub Actions runs
# a step's trap even when the step is cancelled). It cannot run if this
# process is killed with SIGKILL (which cannot be trapped) or if the runner
# itself is destroyed before the trap executes; there is no mechanism in a
# single shell script that can guarantee cleanup across a hard kill. That
# residual risk is accepted, not hidden -- see the PR this script shipped in.
set -euo pipefail

role_prefix="$1"
grants_sql="$2"
revokes_sql="$3"
fixtures_sql="$4"
cleanup_sql="$5"
assertions_sql="$6"
grants_verify_sql="$7"

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
  # Always attempt cleanup exactly once, on every exit path this script can
  # observe: normal completion, an assertion failure, a client authentication
  # failure, or a shell signal (GitHub Actions still runs the trap when a step
  # is interrupted). This cannot fire after SIGKILL or a destroyed runner --
  # see the header comment.
  if [ "$cleanup_ran" = "1" ]; then
    return
  fi
  cleanup_ran=1
  local cleanup_status=0

  # The cleanup SQL itself fails loudly (raises an exception) if its own
  # deletes didn't actually remove every fixture row, rather than merely
  # reporting that its DELETE statements executed without error.
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f "$cleanup_sql" >/dev/null || cleanup_status=1

  # Revoke exactly what tests/rls/*-grants.sql granted, using the
  # administrative connection's own authority as the original grantor.
  # `DROP OWNED BY` is not enough on its own: it requires the administrative
  # role to be a MEMBER of the temporary role, which this script deliberately
  # never grants (that grant-to-self is exactly the pattern a hosted Postgres
  # provider can terminate the connection over), so it is attempted only as a
  # best-effort extra.
  # `-f -` (reading SQL from stdin), not `-c`: psql only performs :"var"/:'var'
  # substitution when parsing a script (stdin or -f a file), not for a bare -c
  # command string.
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v role_name="$role_name" -f "$revokes_sql" >/dev/null 2>&1 || true
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v role_name="$role_name" -f - >/dev/null 2>&1 <<'SQL' || true
revoke authenticated from :"role_name";
SQL
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v role_name="$role_name" -f - >/dev/null 2>&1 <<'SQL' || true
drop owned by :"role_name";
SQL
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v role_name="$role_name" -f - >/dev/null <<'SQL' || cleanup_status=1
drop role if exists :"role_name";
SQL

  # Fail closed: independently re-verify there is no role, no membership
  # involving it, and no ACL/grant entry mentioning it, rather than only
  # trusting that the statements above returned success. This runs in the
  # harness staging itself uses, not only in a later, separate CI job.
  local remaining_role remaining_membership remaining_grants
  remaining_role="$(psql "$ADMIN_URL" -Atqc "select count(*) from pg_roles where rolname = '${role_name}'")"
  remaining_membership="$(psql "$ADMIN_URL" -Atqc "select count(*) from pg_auth_members am join pg_roles r on r.oid = am.member where r.rolname = '${role_name}'")"
  remaining_grants="$(psql "$ADMIN_URL" -Atqc "select count(*) from information_schema.role_table_grants where grantee = '${role_name}'")"
  if [ "$remaining_role" != "0" ] || [ "$remaining_membership" != "0" ] || [ "$remaining_grants" != "0" ]; then
    echo "::error::Residue for ${role_prefix}: role=${remaining_role} membership=${remaining_membership} table_grants=${remaining_grants}"
    cleanup_status=1
  fi

  if [ "$cleanup_status" != "0" ]; then
    echo "::error::RLS check cleanup for ${role_prefix} did not fully succeed -- see prior output."
    exit 1
  fi
  echo "Cleanup verified: role, membership, table grants, and fixtures are all confirmed absent for ${role_prefix}."
}
trap cleanup EXIT INT TERM

echo "Provisioning ephemeral LOGIN role for ${role_prefix} RLS check."
# `-f -` (reading SQL from stdin), not `-c`: psql only performs :"var"/:'var'
# substitution when parsing a script (stdin or -f a file), not for a bare -c
# command string.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v role_name="$role_name" -v role_password="$password" -f - <<'SQL'
create role :"role_name" login password :'role_password'
  nosuperuser nobypassrls nocreatedb nocreaterole noreplication inherit;
SQL
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v role_name="$role_name" -f - <<'SQL'
grant authenticated to :"role_name";
SQL
# The exact, narrow, per-suite privilege allowlist -- never a blanket grant
# across every table in the schema.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v role_name="$role_name" -f "$grants_sql"
# Fails loudly if the role has any privilege beyond this exact allowlist, or
# is missing one it should have -- not just trusting that the GRANT statements
# above ran without error.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v role_name="$role_name" -f "$grants_verify_sql"

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

# Test-only escape hatch (regression coverage: forced login failure):
# deliberately connects with the wrong password, so the client-side login
# itself fails, to prove cleanup still removes the role with no residue even
# when the client never authenticates. Never set outside this script's own
# regression tests.
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
