import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Vercel's Node.js Lambda runtime is Amazon Linux 2 (RHEL family), which needs the
// rhel-openssl-3.0.x query engine binary. `binaryTargets` in prisma/schema.prisma
// makes `prisma generate` produce that file, but Next.js's file-tracing (which
// decides what actually ships in the deployed function bundle) can still drop it
// if the engine isn't reachable from a traced require/read. This script checks the
// real, generated tracing manifest -- not just the schema config -- so a future
// regression can't silently ship a function missing its query engine again.
const REQUIRED_ENGINE_PATTERN = /libquery_engine-rhel-openssl-3\.0\.x\.so\.node$/;

const nftPath = path.resolve(process.argv[2] ?? ".next/server/app/api/health/route.js.nft.json");

if (!existsSync(nftPath)) {
  console.error(
    `Prisma RHEL engine check: file-tracing manifest not found at "${path.basename(nftPath)}". Run "npm run build" first.`,
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(nftPath, "utf8"));
const files = Array.isArray(manifest.files) ? manifest.files : [];
const included = files.some((file) => REQUIRED_ENGINE_PATTERN.test(file));

if (!included) {
  console.error(
    "Prisma RHEL engine check: the rhel-openssl-3.0.x query engine is missing from the " +
      "/api/health function's file-tracing manifest. Vercel's Node.js Lambda runtime needs " +
      "this binary -- without it, Prisma throws PrismaClientInitializationError at request " +
      'time even though "prisma generate" succeeded. Confirm `binaryTargets` in ' +
      'prisma/schema.prisma includes "rhel-openssl-3.0.x" and that next.config.ts keeps ' +
      "@prisma/client external (serverExternalPackages) so Next's tracer can see the engine file.",
  );
  process.exit(1);
}

console.log(
  "Prisma RHEL engine check: rhel-openssl-3.0.x query engine is present in build artifacts.",
);
