#!/usr/bin/env bash
# Independent clean-Linux validation of the production hotfix head (PR #363), mirroring ci.yml's
# Node 22 jobs that apply to a dependency-only change. Credential-free: no Vercel CLI, no pulled
# config, no database, no deploy. Every step's exit code is recorded; the run continues past a failure.
set -uo pipefail
export NEXT_TELEMETRY_DISABLED=1 CI=1
SHA=777eb1a4c5f7c2d1eb59ce24f5ae4516944112d5
# NEXT_PUBLIC_BUILD_SHA is set only for the build step (as in the release build); the unit tests,
# like ci.yml's test job, run without it (health-route tests expect build "unknown" when unset).
mkdir -p /work/src && tar -xf /work/src.tar -C /work/src && cd /work/src
RESULTS=/work/results.txt; : > "$RESULTS"
step() {
  local name="$1"; shift
  echo; echo "===== $name: $*"
  local t0=$(date +%s); "$@"; local rc=$?
  printf '%-34s rc=%-3s %4ss\n' "$name" "$rc" "$(( $(date +%s) - t0 ))" | tee -a "$RESULTS"
}
echo "commit: $SHA"; echo "tar sha256: $(sha256sum /work/src.tar | cut -d' ' -f1)"
echo "node $(node -v), npm $(npm -v), $(uname -srm), $(grep PRETTY_NAME /etc/os-release | cut -d= -f2)"
step "npm ci" npm ci --no-audit --no-fund --loglevel=error
step "installed versions" bash -c 'for p in next sharp @img/sharp-linux-x64 @img/sharp-libvips-linux-x64 source-map-js; do printf "  %s=%s\n" "$p" "$(node -p "require(\"fs\").readFileSync(\"node_modules/$p/package.json\",\"utf8\").match(/\"version\": \"([^\"]+)\"/)[1]")"; done; echo "  sharp copies: $(find node_modules -path "*/sharp/package.json" | wc -l)"; node -e "const s=require(\"sharp\"); console.log(\"  runtime sharp\", s.versions.sharp, \"vips\", s.versions.vips)"'
step "production audit (gate)" npx tsx scripts/run-npm-audit.ts --omit=dev --audit-level=high
step "full audit report (info only)" bash -c 'npm audit --audit-level=high >/tmp/full-audit.txt 2>&1; rc=$?; grep -E "^[a-z@].*  |Severity|vulnerabilities \(" /tmp/full-audit.txt | head -n 30; echo "(ci.yml runs this with continue-on-error: true; it includes dev dependencies)"; exit $rc'
step "prisma generate" npx prisma generate
step "prisma validate" env DATABASE_URL=postgresql://ci:ci@localhost:5432/ci DIRECT_URL=postgresql://ci:ci@localhost:5432/ci npx prisma validate
step "migrations:check" npm run migrations:check
step "format:check" npm run format:check
step "lint" npm run lint
step "typecheck" npm run typecheck
step "i18n:check" npm run i18n:check
step "test" bash -c 'npm test 2>&1 | grep -E "Test Files|Tests |FAIL" ; exit ${PIPESTATUS[0]}'
step "build" env NEXT_PUBLIC_BUILD_SHA=$SHA NEXT_PUBLIC_APP_URL=https://syveka.com bash -c 'npm run build 2>&1 | grep -E "Next.js|Compiled|Generating static pages \(1[0-9]+/|rror" | tail -n 5; exit ${PIPESTATUS[0]}'
step "health route carries SHA" grep -qs -- "$SHA" .next/server/app/api/health/route.js
echo; echo "===== SUMMARY ($SHA)"; cat "$RESULTS"
