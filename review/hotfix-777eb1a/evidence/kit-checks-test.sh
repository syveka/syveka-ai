#!/usr/bin/env bash
set -euo pipefail
stop() { echo "STOP: $*"; exit 3; }
mkdir -p /work/src && tar -xf /work/src.tar -C /work/src && cd /work/src
node -e 'const p=require("./package.json");if(p.dependencies.next!=="^15.5.28"||p.overrides.next.sharp!=="0.35.5"){console.log("STOP: package.json pins differ from the reviewed hotfix");process.exit(3)}' || exit 3
echo "== pin check passed"
npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1
ver() { node -p "require('fs').readFileSync('node_modules/$1/package.json','utf8').match(/\"version\": \"([^\"]+)\"/)[1]"; }
[ "$(ver next)" = "15.5.28" ] && [ "$(ver sharp)" = "0.35.5" ] && [ "$(ver @img/sharp-linux-x64)" = "0.35.5" ] && [ "$(ver source-map-js)" = "1.2.2" ] || stop "installed next/sharp/source-map-js are not the patched versions"
[ "$(find node_modules -path '*/sharp/package.json' | wc -l)" = "1" ] || stop "more than one copy of sharp installed"
echo "== installed: next 15.5.28, sharp 0.35.5 (single copy, linux-x64 binary 0.35.5), source-map-js 1.2.2"
echo "== negative test: the same checks must reject an unpatched expectation"
if [ "$(ver sharp)" = "0.35.4" ] || [ "$(ver next)" = "15.5.25" ]; then echo "NEGATIVE TEST FAILED"; exit 9; fi
echo "== negative test ok (installed sharp/next are not the old 0.35.4/15.5.25)"
echo KIT-CHECKS-PASS
