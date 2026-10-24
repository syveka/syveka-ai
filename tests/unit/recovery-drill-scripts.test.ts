import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The recovery-drill scripts (scripts/recovery-drill) copy production data
 * out of Supabase, so their safety properties are pinned here: every check
 * the validator expects is one the SQL actually reports, the runbook's ten
 * sanitization checks are all present, local containers stay isolated, and
 * only the four Supabase-managed tables a destination needs are carried.
 * The end-to-end proof is the synthetic rehearsal (rehearsal/rehearse.sh),
 * which needs Docker and is run by hand; this file runs the offline
 * self-test of the shared shell helpers.
 */
const dir = path.join(__dirname, "../../scripts/recovery-drill");
const read = (name: string) =>
  fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n?/g, "\n");

const expectedChecks = read("expected-checks.txt")
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#"))
  .map((line) => {
    const [name, rule] = line.trim().split(/\s+/);
    return { name: name!, rule: rule! };
  });
const reportedChecks = [
  ...read("sanitize-checks.sql").matchAll(/select 'check', '([a-z_]+)'/g),
].map((match) => match[1]!);

const RUNBOOK_TEN = [
  "calendar_oauth_tokens",
  "social_tokens",
  "webhook_endpoints",
  "active_workflows",
  "pending_reminders",
  "scheduled_or_inflight_posts",
  "stripe_ids",
  "vapi_assistants_and_numbers",
  "open_invitations",
  "live_booking_tokens",
];

const dockerRuns = (text: string) =>
  text
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => /\bdocker run\b/.test(line) && !line.trim().startsWith("#"));

describe("recovery-drill sanitization checks", () => {
  it("reports exactly the checks the validator expects, each once", () => {
    expect([...reportedChecks].sort()).toEqual(expectedChecks.map((c) => c.name).sort());
    expect(new Set(reportedChecks).size).toBe(reportedChecks.length);
  });

  it("keeps the runbook's ten §5 checks, which must be exactly 0", () => {
    for (const name of RUNBOOK_TEN) {
      expect(expectedChecks).toContainEqual({ name, rule: "zero" });
    }
  });

  it("allows ABSENT only for Auth tables that depend on the Auth version", () => {
    for (const check of expectedChecks) {
      expect(["zero", "zero-absent"]).toContain(check.rule);
      if (check.rule === "zero-absent") expect(check.name).toMatch(/^auth_/);
    }
  });

  it("runs the sanitization as one transaction and keeps identities", () => {
    const sanitize = read("sanitize.sql");
    expect(sanitize).not.toMatch(/\b(begin|commit);/i);
    expect(read("s5-sanitize-offline.sh")).toMatch(/--single-transaction -f \/tmp\/sanitize\.sql/);
    expect(sanitize).not.toMatch(/delete from auth\.(users|identities)\b/i);
    expect(sanitize).not.toMatch(/'identities'/);
  });
});

describe("recovery-drill isolation", () => {
  it("starts every local container with --network none, no ports and no mounts", () => {
    for (const file of ["s5-sanitize-offline.sh", "rehearsal/rehearse.sh"]) {
      const runs = dockerRuns(read(file));
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run).toContain("--network none");
        expect(run).not.toMatch(/\s(-p|--publish|-v|--volume|--mount)\s/);
      }
    }
  });

  it("gives network access only to the remote-mode client, without mounts or ports", () => {
    const runs = dockerRuns(read("s6-restore-disposable.sh"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('"$CLIENT_IMG" sleep infinity');
    expect(runs[0]).not.toMatch(/\s(-p|--publish|-v|--volume|--mount)\s/);
    expect(read("s6-restore-disposable.sh")).toMatch(
      /localtest destination must be a running container with --network none/,
    );
  });

  it("carries only auth.users, auth.identities, storage.buckets and storage.objects", () => {
    const lib = read("lib.sh");
    expect(lib).toContain("local tables=('auth users' 'auth identities')");
    expect(lib).toContain("tables+=('storage buckets' 'storage objects')");
    expect(read("s5-sanitize-offline.sh")).toContain(
      'MANAGED="-t auth.users -t storage.buckets -t storage.objects"',
    );
  });

  it("refuses a non-empty or wrong destination before any write", () => {
    const s6 = read("s6-restore-disposable.sh");
    const guard = s6.indexOf('note "guard=PASS"');
    const firstWrite = s6.indexOf("psql_dest --single-transaction");
    expect(guard).toBeGreaterThan(0);
    expect(firstWrite).toBeGreaterThan(guard);
    for (const refusal of [
      "not the disposable destination",
      "destination is not empty",
      "destination already has a migration history",
      "destination already has $g_users Auth user(s)",
      "destination already has Storage rows",
    ]) {
      expect(s6.slice(0, guard)).toContain(refusal);
    }
  });
});

const bash = spawnSync("bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" });
const hasBash = bash.status === 0 && /^\d/.test(bash.stdout.trim());

describe("recovery-drill shell helpers", () => {
  it.runIf(hasBash)("pass the offline self-test (validator, archive filters, extensions)", () => {
    const run = spawnSync("bash", [path.join(dir, "rehearsal/selftest.sh")], { encoding: "utf8" });
    expect(run.stdout).toContain("selftest: 0 failure(s)");
    expect(run.status).toBe(0);
  });
});
