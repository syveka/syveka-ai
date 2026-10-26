#!/usr/bin/env bash
# Pre-run checks for a Strix source assessment (docs/strix-security-testing-runbook.md §6.1).
# Refuses to pass unless the snapshot, the environment and the sandbox network
# policy meet the runbook's isolation requirements. Prints variable NAMES only,
# never values. Does not start Strix and makes no network calls.
#
# Usage: preflight.sh <snapshot-dir>
# Exit 0 only when every check passes.
set -uo pipefail

snapshot="${1:-}"
failures=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; failures=$((failures + 1)); }
info() { echo "INFO  $*"; }

PINNED_STRIX_VERSION="1.7.0"
PINNED_IMAGE="ghcr.io/usestrix/strix-sandbox:1.3.0"

# ---------------------------------------------------------------- snapshot
if [ -z "$snapshot" ] || [ ! -d "$snapshot" ]; then
  fail "snapshot directory missing: '$snapshot'"
else
  snapshot=$(cd "$snapshot" && pwd)
  if [ -z "$(ls -A "$snapshot")" ]; then
    fail "snapshot directory is empty: $snapshot"
  else
    pass "snapshot directory exists: $snapshot"
  fi

  # Git metadata: a linked worktree's .git FILE points at shared metadata of
  # another checkout; Strix 1.7.0 mounts .git read-only only when it resolves
  # inside the tree, and the pointer still names host paths. Refuse it.
  if [ -f "$snapshot/.git" ]; then
    fail "snapshot/.git is a file (linked worktree pointer to shared git metadata); use 'git archive' or an independent clone"
  elif [ -d "$snapshot/.git" ]; then
    if command -v git >/dev/null 2>&1; then
      # An independent clone reports its own ".git" as the common dir (relative
      # form) and exactly one worktree; a linked worktree reports another path.
      common=$(git -C "$snapshot" rev-parse --path-format=relative --git-common-dir 2>/dev/null || true)
      wt_count=$(git -C "$snapshot" worktree list 2>/dev/null | wc -l | tr -d ' ')
      if [ "$common" != ".git" ] || [ "$wt_count" != "1" ]; then
        fail "snapshot/.git shares metadata with other worktrees (common dir: ${common:-?}, worktrees: ${wt_count:-?})"
      else
        pass "snapshot/.git is an independent clone (one worktree, own common dir)"
      fi
    else
      fail "git not available to inspect snapshot/.git"
    fi
  else
    pass "snapshot carries no .git metadata (archive snapshot)"
  fi

  # Files that must never enter the sandbox. Templates (.env.example etc.) are allowed.
  forbidden=$(
    find "$snapshot" \( -path '*/node_modules' -o -path '*/.next' -o -path '*/strix_runs' -o -path '*/.vercel' -o -path '*/.supabase' \) -prune -print -o \
      \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \
      -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name '.npmrc' -o -name '.netrc' -o -name '_netrc' \
      -o -name '*.dump' -o -name '*.sql.gz' -o -name '*backup*.sql' -o -name 'credentials.json' \
      -o -name 'service-account*.json' -o -name '.git-credentials' -o -name 'tsconfig.tsbuildinfo' \) -print \
      2>/dev/null | grep -vE '\.env(\.[^/]+)?\.(example|sample|template)$' || true
  )
  if [ -n "$forbidden" ]; then
    fail "snapshot contains files that must not enter the sandbox:"
    printf '      %s\n' $forbidden
  else
    pass "snapshot contains no env files, key material, dumps, credential stores, build output or node_modules"
  fi
fi

# ------------------------------------------------------------- environment
# Forbidden names: application and cloud secrets that must never be present in
# the shell that runs Strix. OPENAI_API_KEY is included because strix-agent
# 1.7.0 reads it as a fallback for LLM_API_KEY.
forbidden_names="ANTHROPIC_API_KEY OPENAI_API_KEY DATABASE_URL DIRECT_URL SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SUPABASE_URL STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET RESEND_API_KEY VAPI_API_KEY VAPI_WEBHOOK_SECRET UPSTASH_REDIS_REST_TOKEN UPSTASH_REDIS_REST_URL QSTASH_TOKEN QSTASH_CURRENT_SIGNING_KEY QSTASH_NEXT_SIGNING_KEY SENTRY_DSN LANGFUSE_SECRET_KEY FAL_API_KEY META_APP_SECRET GOOGLE_CALENDAR_CLIENT_SECRET MICROSOFT_CALENDAR_CLIENT_SECRET CALENDAR_TOKEN_ENCRYPTION_KEY SOCIAL_TOKEN_ENCRYPTION_KEY INBOX_EMAIL_WEBHOOK_SECRET RESEND_INBOUND_WEBHOOK_SECRET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN GOOGLE_APPLICATION_CREDENTIALS VERCEL_TOKEN GH_TOKEN GITHUB_TOKEN NPM_TOKEN SUPABASE_ACCESS_TOKEN PERPLEXITY_API_KEY EXA_API_KEY POSTMAN_API_KEY TRACELOOP_API_KEY TRACELOOP_BASE_URL DEDUPE_LLM_API_KEY"
present=""
for name in $forbidden_names; do
  if [ -n "${!name+x}" ]; then present="$present $name"; fi
done
# Any other secret-looking name, except the ones Strix needs.
while IFS='=' read -r name _; do
  case "$name" in
    LLM_API_KEY) continue ;;
  esac
  if printf '%s' "$name" | grep -qE 'SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|SERVICE_ROLE|CREDENTIAL|DSN|CONNECTION_STRING|SIGNING_KEY|ENCRYPTION_KEY'; then
    case " $present " in *" $name "*) ;; *) present="$present $name" ;; esac
  fi
done < <(env)
if [ -n "$present" ]; then
  fail "secret-bearing variables are set in this shell (names only):$present"
else
  pass "no application, cloud or unexpected secret variables in the environment"
fi

[ -n "${STRIX_LLM:-}" ] && pass "STRIX_LLM is set" || fail "STRIX_LLM is not set"
[ -n "${LLM_API_KEY:-}" ] && pass "LLM_API_KEY is set (dedicated key with a provider-side hard limit, see runbook §5.3)" || fail "LLM_API_KEY is not set"
case "${STRIX_TELEMETRY:-}" in
  0 | false | no | off) pass "STRIX_TELEMETRY disables telemetry" ;;
  *) fail "STRIX_TELEMETRY must be 0/false/no/off (is '${STRIX_TELEMETRY:-unset}')" ;;
esac
if [ "${STRIX_IMAGE:-}" = "$PINNED_IMAGE" ]; then
  pass "STRIX_IMAGE is pinned to $PINNED_IMAGE"
else
  fail "STRIX_IMAGE must be exactly $PINNED_IMAGE (is '${STRIX_IMAGE:-unset}')"
fi
[ -z "${DOCKER_HOST:-}" ] && pass "DOCKER_HOST is unset (local daemon)" || fail "DOCKER_HOST is set; a remote daemon is out of scope for this runbook"
[ -z "${STRIX_RUNTIME_BACKEND:-}" ] || [ "${STRIX_RUNTIME_BACKEND}" = "docker" ] && pass "runtime backend is docker" || fail "STRIX_RUNTIME_BACKEND must be unset or 'docker'"

# ------------------------------------------------------------------- tools
if command -v strix >/dev/null 2>&1; then
  v=$(strix --version 2>/dev/null | awk '{print $2}')
  [ "$v" = "$PINNED_STRIX_VERSION" ] && pass "strix $v matches the reviewed version" || fail "strix version '$v' is not the reviewed $PINNED_STRIX_VERSION"
else
  fail "strix is not on PATH"
fi
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    pass "docker daemon reachable"
    if docker image inspect "$PINNED_IMAGE" >/dev/null 2>&1; then
      pass "sandbox image present locally"
    else
      fail "sandbox image $PINNED_IMAGE is not present; pull and inspect it before the run"
    fi
  else
    fail "docker daemon not reachable"
  fi
else
  fail "docker is not on PATH"
fi

# ---------------------------------------------------------- sandbox network
# Strix 1.7.0 puts the sandbox on Docker's default bridge with full egress
# unless STRIX_DOCKER_SANDBOX_NETWORK (source-only setting, undocumented) names
# a user-defined network; it then drops the Caido port publish and expects the
# host to reach the container's IP on that network. Required policy here: an
# `--internal` network (no egress) on a Linux host. Docker Desktop on Windows
# and macOS cannot reach container IPs directly, so this is a blocker there
# (verified on Windows, 2026-10-22).
host_os=$(uname -s 2>/dev/null || echo unknown)
net="${STRIX_DOCKER_SANDBOX_NETWORK:-}"
if [ -z "$net" ]; then
  fail "STRIX_DOCKER_SANDBOX_NETWORK is not set: the sandbox would run on the default bridge with unrestricted egress"
elif ! command -v docker >/dev/null 2>&1; then
  fail "cannot inspect network '$net' without docker"
else
  spec=$(docker network inspect -f '{{.Internal}} {{.Driver}} {{len .Containers}}' "$net" 2>/dev/null || true)
  read -r internal driver attached <<<"${spec:-? ? ?}"
  if [ "$internal" != "true" ]; then
    fail "network '$net' is not an --internal network (internal=$internal driver=$driver)"
  elif [ "$attached" != "0" ]; then
    fail "network '$net' already has $attached container(s) attached; the sandbox must be alone"
  else
    pass "network '$net' is internal (no egress) with no other containers attached"
  fi
fi
case "$host_os" in
  Linux) pass "host is Linux: the host can reach the sandbox on a user-defined network" ;;
  *) fail "host is '$host_os': Docker Desktop cannot reach container IPs on a user-defined network, so the restricted-network mode is unusable here (runbook §4.5 blocker)" ;;
esac

info "Strix 1.7.0 mounts only the -t paths into the sandbox (plus .git/.agents/.codex read-only when present); it does not mount the Docker socket or forward host environment variables (strix/runtime/session_manager.py, docker_client.py)."
info "Model-provider traffic originates from the strix host process, not from the sandbox; only target traffic leaves the sandbox."

if [ "$failures" -eq 0 ]; then
  echo "preflight: PASS"
  exit 0
fi
echo "preflight: FAIL ($failures check(s) failed)"
exit 1
