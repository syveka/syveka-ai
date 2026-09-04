import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 5000;

// `npm audit`'s own advisories backend (registry.npmjs.org/-/npm/v1/security/audits
// and .../advisories/bulk) is a separate service from the package registry itself,
// and has been observed to fail transiently -- both as an HTTP 503 (staging CI) and
// as a plain network timeout (observed locally against the same live registry) --
// while normal installs succeed. Either way npm prints the fixed marker
// "npm error audit endpoint returned an error", with NO "# npm audit report" section
// and no advisory content at all. A real finding never produces that marker, so
// requiring it is what keeps this from ever mistaking a genuine vulnerability (or an
// unrelated npm bug) for an outage; the second pattern then narrows retries to only
// the specific transient transport/service classes this is meant to cover.
const AUDIT_ENDPOINT_ERROR_MARKER = /audit endpoint returned an error/i;
const TRANSIENT_SIGNATURE =
  /\b(429|500|502|503|504)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network timeout|socket hang up/i;

export function isTransientAuditFailure(output: string): boolean {
  return AUDIT_ENDPOINT_ERROR_MARKER.test(output) && TRANSIENT_SIGNATURE.test(output);
}

interface AuditSpawnResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

type AuditSpawn = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => AuditSpawnResult;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runNpmAuditWithRetry(
  args: string[],
  {
    spawn = spawnSync as AuditSpawn,
    delay = sleep,
    maxAttempts = MAX_ATTEMPTS,
  }: { spawn?: AuditSpawn; delay?: (ms: number) => Promise<void>; maxAttempts?: number } = {},
): Promise<number> {
  let result: AuditSpawnResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Windows can only launch npm (a .cmd shim) via a shell -- spawning "npm.cmd"
    // directly fails with EINVAL on Windows regardless. ubuntu-latest (what CI
    // actually runs on) needs no shell either way, so production behavior is
    // unaffected; this only affects local/Windows development. The args are
    // always static, hardcoded flags (never user input), so shell interpretation
    // carries no injection risk here.
    result = spawn("npm", ["audit", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    if (result.error) {
      // npm itself could not even be launched (missing from PATH, corrupted
      // install, etc.) -- an unrecognized failure, so it stays blocking, but
      // must still be diagnosed clearly rather than exiting silently.
      console.error(`Failed to launch npm audit: ${result.error.message}`);
      return 1;
    }

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");

    if (result.status === 0) {
      return 0;
    }

    if (!isTransientAuditFailure(output)) {
      // A real vulnerability finding or an unrecognized failure shape -- both
      // must remain blocking immediately, with no retry.
      return result.status ?? 1;
    }

    if (attempt < maxAttempts) {
      const waitMs = BASE_DELAY_MS * attempt;
      console.error(
        `npm audit's endpoint returned a transient error (attempt ${attempt}/${maxAttempts}); retrying in ${waitMs / 1000}s...`,
      );
      await delay(waitMs);
    }
  }

  console.error(
    `npm audit's security-advisories endpoint was unavailable after ${maxAttempts} attempts. ` +
      "This is an external npm registry outage, not a dependency finding -- re-run once npmjs.org's " +
      "audit endpoint recovers (see https://status.npmjs.org). Failing closed rather than treating " +
      "an unreachable audit as a clean result.",
  );
  return 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // No top-level await: tsx transforms this script to CJS when run directly
  // (matching this repo's other scripts/*.ts, none of which set "type": "module"),
  // and top-level await isn't supported in that output format.
  runNpmAuditWithRetry(process.argv.slice(2)).then((exitCode) => process.exit(exitCode));
}
