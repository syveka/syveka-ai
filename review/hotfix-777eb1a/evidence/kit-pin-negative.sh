set -uo pipefail; mkdir -p /work/src && tar -xf /work/src.tar -C /work/src && cd /work/src
node -e 'const p=require("./package.json");if(p.dependencies.next!=="^15.5.28"||p.overrides.next.sharp!=="0.35.5"){console.log("STOP: package.json pins differ from the reviewed hotfix");process.exit(3)}' || exit 3
echo "rc=$?"
