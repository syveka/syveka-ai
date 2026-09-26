import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Safety controls of the one-off, human-approved staging paid image test.
 * No test here makes a network call; ordinary CI never runs the paid path.
 */
const root = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n?/g, "\n");
const workflow = read(".github/workflows/staging-creator-studio-paid-image.yml");
const spec = read("tests/e2e/creator-studio-paid-image.spec.ts");

type Step = { name: string; text: string; run: string };
const steps: Step[] = workflow
  .split("\n      - name: ")
  .slice(1)
  .map((chunk) => {
    const name = chunk.split("\n")[0]!.trim();
    const runMatch = chunk.match(/\n        run: (?:\|\n)?([\s\S]*?)(?=\n        [a-z-]+:|$)/);
    return { name, text: chunk, run: runMatch?.[1] ?? "" };
  });
const step = (fragment: string) => {
  const found = steps.find((s) => s.name.includes(fragment));
  if (!found) throw new Error(`no step containing "${fragment}"`);
  return found;
};

describe("staging paid image workflow: triggers and gates", () => {
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
  });

  it("never overlaps itself or a running staging release", () => {
    expect(workflow).toMatch(
      /concurrency:\n  group: staging-creator-studio-paid-image\n  cancel-in-progress: false/,
    );
    expect(step("Refuse while a staging release is running").run).toContain(
      "actions/workflows/staging-release.yml/runs?status=$status",
    );
  });

  it("requires the typed paid-request confirmation, a valid experiment id and the staging ref", () => {
    const run = step("Validate inputs").run;
    expect(run).toContain('"$CONFIRM_PAID_REQUEST" != "ONE FAL IMAGE MAX USD 0.10"');
    expect(run).toContain("^cs-paid-img-[a-z0-9][a-z0-9-]{3,40}$");
    expect(run).toContain('"$CONFIRM_STAGING_PROJECT_REF" != "$STAGING_SUPABASE_PROJECT_REF"');
  });
});

describe("staging paid image workflow: order of safety checks", () => {
  const index = (fragment: string) => steps.findIndex((s) => s.name.includes(fragment));

  it("verifies staging identity and the served build before any mutation, and again before claiming", () => {
    expect(index("Validate staging project identity")).toBeLessThan(
      index("Prepare the dedicated fixture"),
    );
    expect(index("Verify the deployed staging build before any mutation")).toBeLessThan(
      index("Prepare the dedicated fixture"),
    );
    expect(index("Preflight")).toBeLessThan(index("Fetch the deployment serving staging"));
    expect(index("Fetch the deployment serving staging")).toBeLessThan(
      index("Check the serving deployment's build and runtime env names"),
    );
    expect(index("Check the serving deployment's build and runtime env names")).toBeLessThan(
      index("Re-verify the deployed staging build"),
    );
    expect(index("Re-verify the deployed staging build")).toBeLessThan(index("Claim"));
    expect(index("Claim")).toBeLessThan(index("Submit exactly one image"));
    for (const name of ["Verify the deployed staging build before any mutation", "Re-verify"]) {
      expect(step(name).run).toContain('"\\"build\\":\\"$EXPECTED_BUILD_SHA\\""');
      expect(step(name).run).toContain("$STAGING_STABLE_URL/api/health");
    }
    expect(workflow).toContain("STAGING_STABLE_URL: https://syveka-ai-staging.vercel.app\n");
  });

  it("submits only after a successful claim, and verifies even after failures", () => {
    expect(step("Submit exactly one image").text).toContain("if: env.PAID_TEST_SUBMIT == '1'");
    expect(step("Claim").text).toContain("if: env.PAID_TEST_STATE == 'ready'");
    expect(step("Preflight").text).toContain("if: env.PAID_TEST_STATE == 'ready'");
    expect(step("Verify the recorded outcome").text).toContain(
      "if: always() && env.PAID_TEST_STATE != ''",
    );
  });

  it("runs Playwright in one project, one worker, zero retries, no traces", () => {
    const runs = steps.filter((s) => s.run.includes("playwright test"));
    expect(runs.map((s) => s.name)).toHaveLength(2);
    for (const s of runs) {
      expect(s.run).toContain("tests/e2e/creator-studio-paid-image.spec.ts");
      for (const flag of ["--project=desktop", "--workers=1", "--retries=0", "--trace=off"]) {
        expect(s.run, s.name).toContain(flag);
      }
    }
    expect(step("Preflight").run).toContain("--grep @preflight");
    expect(step("Submit exactly one image").run).toContain("--grep @submit");
    expect(step("Submit exactly one image").text).toContain(
      'CREATOR_STUDIO_PAID_IMAGE_SUBMIT: "1"',
    );
    expect(step("Preflight").text).not.toContain("CREATOR_STUDIO_PAID_IMAGE_SUBMIT");
    expect(step("Submit exactly one image").text).toContain(
      "EXPECTED_BUILD_SHA: ${{ inputs.expected_build_sha }}",
    );
  });
});

describe("staging paid image workflow: secrets and side effects", () => {
  it("uploads nothing and never deploys or changes Vercel/Supabase configuration", () => {
    expect(workflow).not.toMatch(
      /upload-artifact|actions\/cache@|vercel@|\bvercel (deploy|env|pull|promote|link)|supabase (link|db|functions|secrets)|prisma (migrate|db push)/i,
    );
    expect(workflow).not.toContain("GITHUB_OUTPUT");
  });

  it("uses the Vercel credential only in one read-only curl/jq step", () => {
    const withToken = steps.filter((s) => /STAGING_VERCEL_TOKEN|VERCEL_ORG_ID/.test(s.text));
    expect(withToken.map((s) => s.name)).toEqual([
      "Fetch the deployment serving staging (read-only; Vercel credentials)",
    ]);
    const run = withToken[0]!.run;
    // No repository or dependency code while the credential is present.
    expect(run).not.toMatch(/\b(npm|npx|node|tsx|playwright|prisma|psql)\b/);
    // GET only, and only the alias and deployment lookups.
    expect(run).not.toMatch(/\s(-X|--request|-d|--data[a-z-]*|-F|--form|-T|--upload-file)\b/);
    const paths = [...run.matchAll(/\bapi "([^"]+)"/g)].map((m) => m[1]);
    expect(paths).toEqual([
      "/v4/aliases/${STAGING_STABLE_URL#https://}",
      "/v13/deployments/$deployment_id",
    ]);
    // Never prints responses; project identity checked for both.
    expect(run).not.toMatch(/\bcat\b|echo "\$\(|tee\b/);
    expect(run.match(/!= "\$STAGING_VERCEL_PROJECT_ID"/g)).toHaveLength(2);
    expect(run).toContain('[ "$STAGING_VERCEL_PROJECT_ID" = "$PRODUCTION_VERCEL_PROJECT_ID" ]');
    const check = step("Check the serving deployment's build and runtime env names");
    expect(check.text).not.toContain("secrets.");
    expect(check.run).toContain("creator-studio-paid-image-fixture.ts check-deployment");
  });

  it("exposes database/service-role secrets only to the identity and fixture steps", () => {
    const allowed = new Set([
      "Validate staging project identity",
      "Prepare the dedicated fixture (identity, org, flag, credits)",
      "Claim the single paid request for this experiment",
      "Verify the recorded outcome (database, ledger, stored image)",
    ]);
    for (const s of steps) {
      if (/secrets\.STAGING_(DIRECT_URL|DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY)/.test(s.text)) {
        expect(allowed.has(s.name), s.name).toBe(true);
      }
    }
    expect(step("Claim").text).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    // The shared E2E account's email is only a base for the fixture sub-address;
    // its password is never used.
    expect(workflow).not.toContain("STAGING_E2E_USER_PASSWORD");
    for (const s of steps.filter((x) => x.text.includes("secrets.STAGING_E2E_USER_EMAIL"))) {
      expect(s.name).toBe("Prepare the dedicated fixture (identity, org, flag, credits)");
    }
  });

  it("keeps secrets out of the browser steps and workflow/job-level env", () => {
    for (const s of steps.filter((x) => x.run.includes("playwright test"))) {
      expect(s.text, s.name).not.toContain("secrets.");
    }
    const beforeSteps = workflow.slice(0, workflow.indexOf("\n    steps:"));
    expect(beforeSteps).not.toContain("secrets.");
  });
});

describe("paid image spec gating (never runs in ordinary CI or staging smoke)", () => {
  it("is skipped unless the workflow enables it, and submits only when the claim allowed it", () => {
    expect(spec).toContain('const ENABLED = process.env.CREATOR_STUDIO_PAID_IMAGE_TEST === "1";');
    expect(spec).toContain('const SUBMIT = process.env.CREATOR_STUDIO_PAID_IMAGE_SUBMIT === "1";');
    expect(spec).toContain(
      'test.skip(!ENABLED, "Runs only from the staging paid-image workflow.");',
    );
    expect(spec).toContain(
      'test.skip(!SUBMIT, "The claim step did not authorize a submission for this run.");',
    );
    expect(spec).toContain('mode: "serial", retries: 0');
  });

  it("clicks Generate exactly once and never resubmits after a timeout", () => {
    expect(spec.match(/generate\.click\(\)/g)).toHaveLength(1);
    expect(spec).toMatch(
      /\.waitFor\(\{ timeout: GENERATION_WAIT_MS \}\)\s*\.catch\(\(\) => undefined\)/,
    );
  });

  it("pins No template + 1:1 and re-checks the served build immediately before the click", () => {
    const submitBody = spec.slice(spec.indexOf('test("@submit'));
    const click = submitBody.indexOf("generate.click()");
    expect(submitBody.indexOf("pinNoTemplateSquareImage(page)")).toBeLessThan(click);
    const shaCheck = submitBody.indexOf("assertServingExpectedBuild(page.request)");
    expect(shaCheck).toBeGreaterThan(submitBody.indexOf("toBeEnabled()"));
    expect(shaCheck).toBeLessThan(click);
    expect(spec).toContain('await template.selectOption("");');
    expect(spec).toContain('await expect(template).toHaveValue("");');
    expect(spec).toContain('await ratio("1:1").click();');
  });

  it("verifies the fal endpoint from provider metadata, never the row's model field", () => {
    expect(spec).toContain("parseProviderSubmission(g.providerRequestId)");
    expect(spec).not.toMatch(/g\.model\b|model: PAID_IMAGE_TEST\.model/);
    // No whole-object assertions that would print raw provider metadata.
    expect(spec).not.toMatch(/expect\(g\)|toMatchObject\(/);
  });

  it("sends every creator-studio HTTP call through the sanitizer", () => {
    expect(spec).toMatch(/sanitizedCall\("reference upload", \(\) =>\s+api\.put\(signedUrl/);
    expect(spec.match(/\bapi\.(get|post|put)\(/g)?.length).toBe(
      spec.match(/sanitizedCall\([^)]*\(\) =>\s+api\.(get|post|put)\(/g)?.length,
    );
  });

  it("requires the fal estimate (20) and rejects the mock estimate (10) before submitting", () => {
    expect(spec).toContain("Estimated cost: ${PAID_IMAGE_TEST.targetCredits} credits");
    expect(spec).toContain("Estimated cost: ${PAID_IMAGE_TEST.mockImageCredits} credits");
    const submitBody = spec.slice(spec.indexOf('test("@submit'));
    expect(submitBody.indexOf("openCreateAndAssertFalEstimate")).toBeLessThan(
      submitBody.indexOf("generate.click()"),
    );
    expect(submitBody.indexOf("assertNeverSpentAndFunded")).toBeLessThan(
      submitBody.indexOf("generate.click()"),
    );
  });

  it("is never enabled by any other workflow", () => {
    for (const file of fs.readdirSync(path.join(root, ".github/workflows"))) {
      if (file === "staging-creator-studio-paid-image.yml") continue;
      expect(read(`.github/workflows/${file}`), file).not.toMatch(
        /CREATOR_STUDIO_PAID_IMAGE_(TEST|SUBMIT)/,
      );
    }
  });

  it("uses the approved prompt", () => {
    expect(spec).toContain(
      "A clean studio photograph of a small green plant in a white ceramic pot on a light neutral background, soft daylight, no text, no logos.",
    );
  });
});
