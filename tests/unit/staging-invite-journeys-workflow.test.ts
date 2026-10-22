import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITLEMENT_CACHE_WAIT_SECONDS } from "../../scripts/lib/invite-journeys";

/**
 * Safety controls of the staging invitation journeys: the manual workflow,
 * the fixture script and the opt-in spec. Static checks only; nothing here
 * reaches staging. Ordinary CI never runs the journeys.
 */
const root = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n?/g, "\n");
const workflow = read(".github/workflows/staging-invite-journeys.yml");
const script = read("scripts/invite-journey-fixtures.ts");
const lib = read("scripts/lib/invite-journeys.ts");
const spec = read("tests/e2e/invite-journeys.spec.ts");

type Step = { name: string; text: string; run: string; index: number };
const steps: Step[] = workflow
  .split("\n      - name: ")
  .slice(1)
  .map((chunk, index) => {
    const name = chunk.split("\n")[0]!.trim();
    const runMatch = chunk.match(/\n        run: (?:\|\n)?([\s\S]*?)(?=\n        [a-z-]+:|$)/);
    return { name, text: chunk, run: runMatch?.[1] ?? "", index };
  });
const step = (fragment: string) => {
  const found = steps.find((s) => s.name.includes(fragment));
  if (!found) throw new Error(`no step containing "${fragment}"`);
  return found;
};

describe("staging invitation journeys workflow: triggers and gates", () => {
  it("runs only on manual dispatch", () => {
    const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(on).toContain("workflow_dispatch:");
    expect(on).not.toMatch(
      /\b(push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch):/,
    );
  });

  it("uses the staging environment approval gate, main only, least privilege", () => {
    expect(workflow).toContain("    environment: staging\n");
    expect(workflow).toContain("    if: github.ref == 'refs/heads/main'\n");
    expect(workflow).toMatch(/\npermissions:\n  contents: read\n  actions: read\n\n/);
    expect(workflow).not.toMatch(/environment: production/);
  });

  it("never overlaps itself or a running staging release", () => {
    expect(workflow).toMatch(
      /concurrency:\n  group: staging-invite-journeys\n  cancel-in-progress: false/,
    );
    expect(step("Refuse while a staging release is running").run).toContain(
      "actions/workflows/staging-release.yml/runs?status=$status",
    );
  });

  it("requires the typed staging ref, a different production ref and a full build SHA", () => {
    const run = step("Validate inputs").run;
    expect(run).toContain('"$CONFIRM_STAGING_PROJECT_REF" != "$STAGING_SUPABASE_PROJECT_REF"');
    expect(run).toContain('"$STAGING_SUPABASE_PROJECT_REF" = "$PRODUCTION_SUPABASE_PROJECT_REF"');
    expect(run).toContain("^[0-9a-f]{40}$");
  });

  it("checks identity and the served build before the first fixture read or write", () => {
    const identity = step("Validate staging project identity");
    const build = step("Verify the deployed staging build before any change");
    const preview = step("Preview the fixtures (read-only)");
    const prepare = step("Prepare the marked fixtures");
    expect(identity.text).toContain("STAGING_CONFIG_MODE: identity");
    expect(build.run).toContain('"build\\":\\"$EXPECTED_BUILD_SHA\\"');
    expect(identity.index).toBeLessThan(build.index);
    expect(build.index).toBeLessThan(preview.index);
    expect(preview.index).toBeLessThan(prepare.index);
  });
});

describe("staging invitation journeys workflow: run and cleanup", () => {
  it("waits past the 60 s entitlement cache between prepare and the journeys", () => {
    const wait = step("Wait for the entitlement cache");
    expect(wait.run.trim()).toBe(`sleep ${ENTITLEMENT_CACHE_WAIT_SECONDS}`);
    expect(ENTITLEMENT_CACHE_WAIT_SECONDS).toBeGreaterThan(60);
    expect(step("Prepare the marked fixtures").index).toBeLessThan(wait.index);
    expect(wait.index).toBeLessThan(step("Run the invitation journeys").index);
  });

  it("runs the opt-in spec serially, without retries or traces", () => {
    const journeys = step("Run the invitation journeys");
    expect(journeys.run).toContain("tests/e2e/invite-journeys.spec.ts --project=desktop");
    expect(journeys.run).toContain("--workers=1 --retries=0 --trace=off");
    expect(journeys.text).toContain('E2E_INVITE_JOURNEYS: "1"');
  });

  it("always resets after prepare ran, then re-previews and re-checks health", () => {
    const reset = step("Reset the fixtures to their baseline");
    expect(reset.text).toContain("if: always() && steps.prepare.outcome != 'skipped'");
    expect(reset.run).toContain("invite-journey-fixtures.ts reset");
    const after = step("Preview the fixtures after cleanup");
    expect(after.text).toContain("if: always()");
    expect(reset.index).toBeLessThan(after.index);
    expect(step("Verify staging health after the run").text).toContain("if: always()");
  });

  it("tears down only when explicitly asked", () => {
    expect(step("Delete the fixtures (teardown)").text).toContain(
      "if: inputs.action == 'teardown'",
    );
    for (const name of [
      "Prepare the marked",
      "Wait for the entitlement",
      "Run the invitation journeys",
    ]) {
      expect(step(name).text).toContain("if: inputs.action == 'run'");
    }
  });

  it("uploads no artifacts and carries no email, billing, voice or AI credentials", () => {
    expect(workflow).not.toMatch(/upload-artifact/);
    expect(workflow).not.toMatch(/RESEND|STRIPE|VAPI|ANTHROPIC|OPENAI|FAL_|VERCEL_TOKEN/);
    expect(workflow).not.toMatch(/secrets\.PRODUCTION|secrets\.PROD_/);
  });
});

describe("invitation fixture script: no email, staging only, no token output", () => {
  it("never goes through the email-sending invitation path or any email-sending auth call", () => {
    // Code only: the doc comments name inviteMember() to explain why it is avoided.
    const code = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const source of [script, lib, spec].map(code)) {
      expect(source).not.toMatch(/@\/server|services\/members|integrations\/resend|from "resend"/);
      expect(source).not.toMatch(
        /\binviteMember\b|\bsendEmail\b|\.signUp\(|inviteUserByEmail|generateLink|resetPasswordForEmail|signInWithOtp/,
      );
    }
  });

  it("creates identities pre-confirmed (no confirmation email)", () => {
    const create = script.slice(script.indexOf("admin.auth.admin.createUser("));
    expect(create.slice(0, create.indexOf("});"))).toContain("email_confirm: true");
    expect(script.match(/createUser\(/g)).toHaveLength(1);
  });

  it("proves the staging target before connecting to anything", () => {
    const main = script.slice(script.indexOf("async function main()"));
    expect(main.indexOf("assertTarget();")).toBeGreaterThan(-1);
    expect(main.indexOf("assertTarget();")).toBeLessThan(main.indexOf("connect()"));
  });

  it("never reads or prints invitation tokens, and reduces unexpected errors to their name", () => {
    expect(script).not.toMatch(/\.token\b|\btoken:|"token"/);
    expect(script).toContain(
      '`${LOG_PREFIX}: unexpected ${error instanceof Error ? error.name : "error"}`',
    );
    expect(script).toContain("::add-mask::");
  });

  it("deletes only inside the fixture orgs and identities", () => {
    expect(script).toMatch(
      /invitation\.deleteMany\(\{\s*where: \{ organizationId: \{ in: fixtureOrgIds \} \}/,
    );
    expect(script).toContain('role: { not: "OWNER" }');
    expect(script).toContain("planReset(");
    expect(script).toContain("assertTeardownSafe(s);");
  });
});

describe("invitation journeys spec: opt-in and leak-safe", () => {
  it("is skipped unless explicitly enabled, and runs once on desktop", () => {
    expect(spec).toContain('const JOURNEYS_ENABLED = process.env.E2E_INVITE_JOURNEYS === "1";');
    expect(spec).toContain('test.info().project.name !== "desktop"');
  });

  it("records no traces, screenshots or video, runs serially and never retries", () => {
    expect(spec).toContain('test.use({ trace: "off", screenshot: "off", video: "off" });');
    expect(spec).toContain('test.describe.configure({ mode: "serial", retries: 0 });');
  });

  it("redacts every failure and never logs", () => {
    expect(spec).toMatch(/throw new Error\(`\$\{label\}: \$\{redact\(message\)/);
    expect(spec).not.toMatch(/console\.(log|info|warn|error)/);
    // The only direct test() is inside journey(), which wraps the body in guarded().
    expect(spec.match(/^\s*test\(/gm) ?? []).toHaveLength(1);
    expect(spec).toMatch(
      /function journey\([\s\S]*?\n  test\(title, async \(\{ page, browser \}\) =>\s*guarded\(title,/,
    );
  });

  it("covers every planned journey and the localization split", () => {
    for (const title of [
      "D1 (EN)",
      "A (EN)",
      "B (FI)",
      "C (AR)",
      "D2 (EN)",
      "F (AR)",
      "G (EN)",
      "E (EN)",
      "H (FI)",
    ]) {
      expect(spec).toMatch(new RegExp(`journey\\(\\s*"${title.replace(/[()]/g, "\\$&")}`));
    }
  });
});
