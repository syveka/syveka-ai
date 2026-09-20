import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Prisma's Rust-free client (generator client { provider = "prisma-client", engineType =
// "client" } in prisma/schema.prisma) has no native, per-platform query engine binary at
// all -- query compilation is done by a portable WASM module embedded as base64 inside
// @prisma/client/runtime, and all database I/O goes through the @prisma/adapter-pg driver
// adapter (see src/server/db/prisma.ts). This previously guarded the OPPOSITE invariant
// (that the classic engine's rhel-openssl-3.0.x binary shipped with the Vercel Lambda
// bundle); now it guards that no such native binary has crept back in, since one appearing
// again would mean a dependency or config regressed back toward the classic Rust-engine
// architecture that caused the Supavisor prepared-statement incompatibility this migration
// fixed.
const NATIVE_ENGINE_PATTERN = /query[_-]engine[^/\\]*\.(so|dll|dylib)\.node$/;

const nftPath = path.resolve(process.argv[2] ?? ".next/server/app/api/health/route.js.nft.json");

if (!existsSync(nftPath)) {
  console.error(
    `Prisma native-engine-absence check: file-tracing manifest not found at "${path.basename(nftPath)}". Run "npm run build" first.`,
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(nftPath, "utf8"));
const files = Array.isArray(manifest.files) ? manifest.files : [];
const nativeEngineFiles = files.filter((file) => NATIVE_ENGINE_PATTERN.test(file));

if (nativeEngineFiles.length > 0) {
  console.error(
    "Prisma native-engine-absence check: a native Prisma query engine binary is present in " +
      `the /api/health function's file-tracing manifest (${nativeEngineFiles.join(", ")}). ` +
      'The schema\'s "generator client" block should use provider = "prisma-client" with ' +
      'engineType = "client" and no binaryTargets -- a native binary showing up here means ' +
      "the build has regressed back toward the classic Rust-engine architecture.",
  );
  process.exit(1);
}

console.log(
  "Prisma native-engine-absence check: no native query engine binary present in build artifacts.",
);
