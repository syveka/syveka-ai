#!/usr/bin/env bash
# OWNER-RUN ONLY. Runs inside a throwaway node:22-bookworm container started by stage1-build-and-stage.ps1.
# HOTFIX KIT: Linux build of the production security hotfix 777eb1a (PR #363; parent fc645727; next 15.5.28,
# sharp 0.35.5, source-map-js 1.2.2; dependency-only). Copied from the 2026-10-23 recovery kit, which stays unchanged.
# Mirrors deploy.yml (Node 22, vercel@56.3.2): pull production config, build with NO Vercel credential visible,
# deploy --prebuilt --prod --skip-domain (production alias NOT moved). No migration runs; no DB credential is needed at build.
# Auth: the owner's Vercel CLI config dir is copied to /work/vc (root-only); it never appears in argv, env or output.
set -euo pipefail
export VERCEL_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
SHA=777eb1a4c5f7c2d1eb59ce24f5ae4516944112d5
VC="npx -y vercel@56.3.2"
G=/work/vc
stop() { echo "STOP: $*"; exit 3; }

[ -f "$G/auth.json" ] || stop "no Vercel login was copied into the container"
chown -R root:root "$G" && chmod -R go-rwx "$G" && chmod 700 "$G"

mkdir -p /work/src && tar -xf /work/src.tar -C /work/src && cd /work/src
mkdir -p .vercel && printf '{"projectId":"<REDACTED_VERCEL_PROJECT_ID>","orgId":"<REDACTED_VERCEL_ORG_ID>"}' > .vercel/project.json
echo "== node $(node -v), npm $(npm -v), $(uname -sm)"
test -f package-lock.json || stop "package-lock.json missing"
node -e 'const s=require("./package.json").scripts||{};for(const k of ["preinstall","install","postinstall","prepare","prebuild","postbuild"]) if(s[k]){console.log("STOP: lifecycle script "+k);process.exit(3)}; if(s.build!=="prisma generate && next build"){console.log("STOP: unexpected build script: "+s.build);process.exit(3)}; console.log("== build script: "+s.build+" (no migrate)")'
[ ! -f vercel.json ] || ! grep -Eq '"(buildCommand|installCommand)"' vercel.json || stop "vercel.json overrides build/install"
# The hotfix's dependency pins must be the ones that were reviewed.
node -e 'const p=require("./package.json");if(p.dependencies.next!=="^15.5.28"||p.overrides.next.sharp!=="0.35.5"){console.log("STOP: package.json pins differ from the reviewed hotfix");process.exit(3)}' || exit 3

who=$($VC whoami -Q "$G" 2>/dev/null | tail -n1) || true
[ -n "$who" ] || stop "Vercel login invalid or expired (owner: run 'npx -y vercel@56.3.2 login' in your own PowerShell, then rerun stage 1)"
echo "== Vercel account: $who"

echo "== pulling production project settings and env (inside this container only)"
$VC pull --yes --environment=production -Q "$G" >/dev/null 2>&1 || stop "vercel pull failed"
PULLED=.vercel/.env.production.local
[ -f "$PULLED" ] || stop "pulled env file missing"
! grep -Eq 'postgres(ql)?://[^[:space:]:]+:[^@[:space:]<]+@' "$PULLED" || stop "a database URL with a password was pulled; aborting"
app_url=$(node --env-file="$PULLED" -e 'process.stdout.write(process.env.NEXT_PUBLIC_APP_URL ?? "")')
[ "$app_url" = "https://syveka.com" ] || stop "NEXT_PUBLIC_APP_URL is not https://syveka.com"
echo "== NEXT_PUBLIC_APP_URL = $app_url"

echo "== npm ci + vercel build --prod as unprivileged user 'node' (cannot read the Vercel login)"
chown -R node:node /work/src
runuser -u node -- env HOME=/home/node NEXT_PUBLIC_BUILD_SHA="$SHA" VERCEL_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1 \
  bash -c 'set -euo pipefail; npm ci --no-audit --no-fund --loglevel=error; npx -y vercel@56.3.2 build --prod > /tmp/build.log 2>&1 || { tail -n 40 /tmp/build.log | grep -vE "postgres(ql)?://"; exit 5; }; tail -n 6 /tmp/build.log | grep -vE "postgres(ql)?://"'

ver() { node -p "require('fs').readFileSync('node_modules/$1/package.json','utf8').match(/\"version\": \"([^\"]+)\"/)[1]"; }
[ "$(ver next)" = "15.5.28" ] && [ "$(ver sharp)" = "0.35.5" ] && [ "$(ver @img/sharp-linux-x64)" = "0.35.5" ] && [ "$(ver source-map-js)" = "1.2.2" ] || stop "installed next/sharp/source-map-js are not the patched versions"
[ "$(find node_modules -path '*/sharp/package.json' | wc -l)" = "1" ] || stop "more than one copy of sharp installed"
echo "== installed: next 15.5.28, sharp 0.35.5 (single copy, linux-x64 binary 0.35.5), source-map-js 1.2.2"
grep -qs -- "$SHA" .next/server/app/api/health/route.js || stop "build SHA not inlined in the health route"
echo "== build SHA inlined in health route: $SHA"
if grep -rlE 'postgres(ql)?://[^[:space:]:"'"'"'<]+:[^@[:space:]"'"'"'<]+@' .vercel/output 2>/dev/null | grep -v 'example' | grep -q .; then stop "a credential-bearing URL is in the build output"; fi
# Real Windows drive paths only (the earlier Windows-build failure was route args like ../E:\rotation-build\src\...).
# Decodes the JSON and checks every string; regex escapes such as (?:\.rsc) or (?:\/ are not paths and do not match.
node -e 'const c=require("/work/src/.vercel/output/config.json");const h=[];const w=(v,p)=>{if(typeof v==="string"){if(/(^|[^A-Za-z])[A-Za-z]:\\[A-Za-z0-9_]/.test(v))h.push(p)}else if(v&&typeof v==="object")for(const[k,x]of Object.entries(v))w(x,p+"."+k)};w(c,"config");if(h.length){console.log("Windows drive paths in: "+h.slice(0,5).join(", "));process.exit(1)}' || stop "Windows drive paths found in route config"
echo "== output checks passed (no credential URLs, no Windows paths)"

echo "== deploy --prebuilt --prod --skip-domain (staged; production alias NOT moved)"
url=$($VC deploy --prebuilt --prod --skip-domain -Q "$G" 2>/tmp/deploy.err | tail -n1) || { tail -n 15 /tmp/deploy.err; stop "deploy failed"; }
[[ "$url" =~ ^https://[a-z0-9.-]+\.vercel\.app$ ]] || { tail -n 15 /tmp/deploy.err; stop "Vercel did not return a deployment URL"; }
echo "STAGED_URL=$url"
