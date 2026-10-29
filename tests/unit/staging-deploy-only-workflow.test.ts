import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * staging-deploy-only.yml creates a new staging deployment of a pinned, reviewed
 * commit (Vercel cannot redeploy prebuilt deployments from the dashboard) without
 * any of staging-release.yml's database work. It must keep that workflow's Vercel
 * credential isolation: STAGING_VERCEL_TOKEN is team-scoped and could deploy the
 * production project, so it may only reach steps that run nothing but the Vercel
 * CLI's `pull`/`deploy`/`promote` plus curl/jq, never repository code.
 */
const workflowsDir = path.join(__dirname, "../../.github/workflows");
const read = (name: string) =>
  fs.readFileSync(path.join(workflowsDir, name), "utf8").replace(/\r\n?/g, "\n");
const workflow = read("staging-deploy-only.yml");

type Step = { name: string; text: string; run: string };

const steps: Step[] = workflow
  .split("\n      - name: ")
  .slice(1)
  .map((chunk) => {
    const name = chunk.split("\n")[0]!.trim();
    const runMatch = chunk.match(/\n        run: (?:\|\n)?([\s\S]*?)(?=\n        [a-z-]+:|$)/);
    return { name, text: chunk, run: runMatch?.[1] ?? "" };
  });
const stepNamed = (name: string): Step => {
  const step = steps.find((s) => s.name === name);
  expect(step, name).toBeDefined();
  return step!;
};
const indexOf = (name: string) => steps.indexOf(stepNamed(name));

const TOKEN = /STAGING_VERCEL_TOKEN|VERCEL_TOKEN|--token/;
const VERCEL_BUILD = /vercel@\$VERCEL_CLI_VERSION" build\b|\bvercel build\b/;
const RUNS_REPO_CODE =
  /\bnpm (ci|install|test|run)\b|\bnpx (tsx|playwright|prisma|next)\b|\bnode (--env-file|scripts\/|-e)|\bnext build\b|\bpsql\b/;
const PINNED = "611fd74ecf99d405252eb3bcfc291e363f5f970e";

const PULL = "Pull stable staging alias config (Vercel credentials)";
const BUILD = "Build pinned candidate for the stable staging alias (no Vercel credentials)";
const DEPLOY = "Deploy pinned candidate as a staged deployment (Vercel credentials)";
const STAGED_HEALTH =
  "Verify the staged deployment serves the pinned source with a healthy database";
const PROMOTE = "Promote the verified deployment to the stable staging alias (Vercel credentials)";
const ALIAS =
  "Verify the stable staging alias points at the promoted deployment (Vercel credentials)";
const ALIAS_HEALTH =
  "Prove the stable staging alias serves the pinned source with a healthy database";
const HEALTH_PREDICATE = `'.status == "healthy" and .checks.database == "ok" and .build == $sha'`;

const tokenSteps = steps.filter((step) => TOKEN.test(step.text));
const buildSteps = steps.filter((step) => VERCEL_BUILD.test(step.run));

function guardBlock(text: string): string {
  const start = text.indexOf('          guard_token="$STAGING_VERCEL_TOKEN"');
  const end = text.indexOf("          # <<< token-persistence guard");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("staging-deploy-only.yml scope", () => {
  it("is manual, main-only, staging-only, read-only and serialized with staging releases", () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|schedule|workflow_run):/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).toMatch(
      /^concurrency:\n {2}group: staging-release\n {2}cancel-in-progress: false\n/m,
    );
    expect(workflow).toContain("    if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("    environment: staging\n");
    expect(workflow).toContain("    timeout-minutes: 45\n");
    expect(workflow).not.toMatch(/environment: production/);
    expect(steps[0]!.name).toBe("Refuse non-staging targets");
  });

  it("has no step that can be skipped, tolerated or run after a failure", () => {
    expect(workflow).not.toMatch(/continue-on-error/);
    expect(workflow).not.toMatch(/^ {8}if:/m);
    expect(workflow).not.toMatch(/always\(\)|failure\(\)/);
  });

  it("pins the application source and proves it everywhere", () => {
    expect(workflow).toContain(`  PINNED_SOURCE_SHA: ${PINNED}\n`);
    expect(workflow).toContain("ref: ${{ env.PINNED_SOURCE_SHA }}");
    expect(workflow).toContain("          fetch-depth: 0\n");
    expect(workflow).toContain("          persist-credentials: false\n");
    expect(workflow).toContain("NEXT_PUBLIC_BUILD_SHA: ${{ env.PINNED_SOURCE_SHA }}");
    expect(workflow).not.toContain("github.sha");
    expect(workflow).toContain('[ "$CONFIRM_SOURCE_SHA" != "$PINNED_SOURCE_SHA" ]');
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$PINNED_SOURCE_SHA" refs/remotes/origin/main',
    );
  });

  it("runs no migrations, database SQL, fixtures, E2E account changes or artifact uploads", () => {
    for (const forbidden of [
      /prisma migrate/,
      /\bpsql\b/,
      /004_storage|006_legacy/,
      /ensure-e2e|auth-journey|journey-fixtures/,
      /playwright/i,
      /upload-artifact/,
      /STAGING_DATABASE_URL|STAGING_DIRECT_URL/,
      /SUPABASE_SERVICE_ROLE_KEY|E2E_USER_PASSWORD|E2E_USER_EMAIL/,
      /recovery/i,
    ]) {
      expect(workflow).not.toMatch(forbidden);
    }
  });

  it("keeps the reviewed Linux build and Prisma RHEL engine check", () => {
    expect(workflow).toContain("    runs-on: ubuntu-latest\n");
    expect(workflow).toContain('  VERCEL_CLI_VERSION: "56.3.2"\n');
    expect(workflow).toContain('  NODE_VERSION: "22"\n');
    expect(indexOf("Verify Prisma RHEL query engine is included in build artifacts")).toBe(
      indexOf("Production build") + 1,
    );
    expect(workflow).toContain("run: node scripts/verify-prisma-engine.mjs");
  });

  it("positively verifies the staging Vercel project before pulling or deploying", () => {
    const pull = stepNamed(PULL);
    expect(workflow).toContain("  STAGING_VERCEL_PROJECT_NAME: syveka-ai-staging\n");
    expect(pull.run).toContain(
      "https://api.vercel.com/v9/projects/$VERCEL_PROJECT_ID?teamId=$VERCEL_ORG_ID",
    );
    expect(pull.run).toContain(
      "'.id == $id and .accountId == $org and .name == $name and .id != $prod'",
    );
    expect(pull.run.indexOf("v9/projects")).toBeLessThan(pull.run.indexOf('" pull --yes'));
    expect(pull.run).toContain(
      '" pull --yes --environment=production --token="$STAGING_VERCEL_TOKEN"',
    );
  });

  it("masks the pulled database URLs, then verifies they target staging, without printing them", () => {
    const build = stepNamed(BUILD);
    const mask = build.run.indexOf("::add-mask::");
    expect(mask).toBeGreaterThan(-1);
    // The runner unescapes %25/%0A/%0D in command data, so literal `%` must be escaped.
    expect(build.run).toContain('`::add-mask::${value.replace(/%/g, "%25")}\\n`');
    // Mask only the pulled file: sweeping process.env would mask the pinned SHA and the
    // stable URL and blank the proof lines later in the log.
    expect(build.run).toContain(
      'parseEnv(require("node:fs").readFileSync(".vercel/.env.production.local"',
    );
    expect(build.run).not.toContain("Object.entries(process.env)");
    expect(mask).toBeLessThan(build.run.indexOf("validate-staging-config.mjs"));
    expect(mask).toBeLessThan(build.run.indexOf('" build --prod'));
    expect(build.run).toContain(
      "STAGING_CONFIG_MODE=runtime node --env-file=.vercel/.env.production.local scripts/validate-staging-config.mjs",
    );
    expect(build.run).toContain(
      "DIRECT_URL (Production) does not identify the staging Supabase project ref.",
    );
    expect(build.run).toContain('if (url.port === "6543") {');
    expect(build.run).not.toMatch(/console\.log\([^)]*(raw|url\.href|url\.password)/);
  });

  it("deploys staged, checks the deployment, then promotes and proves the alias moved", () => {
    const deploy = stepNamed(DEPLOY);
    expect(deploy.run).toContain(
      '" deploy --prebuilt --prod --skip-domain --token="$STAGING_VERCEL_TOKEN"',
    );
    expect(deploy.run.indexOf("'.targets.production.id // empty'")).toBeLessThan(
      deploy.run.indexOf('" deploy --prebuilt'),
    );
    expect(deploy.run).toContain('[ "$ready_substate" != "STAGED" ]');
    expect(deploy.run).toContain('[ "$target" != "production" ]');
    expect(deploy.run).toContain('[ "$project_id" != "$VERCEL_PROJECT_ID" ]');
    expect(deploy.run).toContain("for name in DATABASE_URL DIRECT_URL FAL_API_KEY; do");
    expect(stepNamed(PROMOTE).run).toContain(
      '" promote "$CANDIDATE_DEPLOYMENT_ID" --timeout 5m --yes --token="$STAGING_VERCEL_TOKEN"',
    );
    const alias = stepNamed(ALIAS);
    expect(alias.run).toContain('aliased_id=$(api "/v4/aliases/$domain"');
    expect(alias.run).toContain(
      '[ "$live_id" = "$CANDIDATE_DEPLOYMENT_ID" ] && [ "$ready_substate" = "PROMOTED" ] && [ "$aliased_id" = "$CANDIDATE_DEPLOYMENT_ID" ]',
    );
    // The rollback target is logged before deploying, and the run fails closed without one.
    expect(deploy.run).toContain('if [[ ! "$previous_id" =~ ^dpl_[A-Za-z0-9]+$ ]]; then');
    const order = [
      "Require Vercel protection bypass secret",
      DEPLOY,
      STAGED_HEALTH,
      PROMOTE,
      ALIAS,
      ALIAS_HEALTH,
    ].map(indexOf);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("checks the source SHA and database health on the staged deployment and the stable alias", () => {
    for (const name of [STAGED_HEALTH, ALIAS_HEALTH]) {
      expect(stepNamed(name).run, name).toContain(HEALTH_PREDICATE);
    }
    expect(stepNamed(STAGED_HEALTH).run).toContain(
      '-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"',
    );
  });
});

describe("staging-deploy-only.yml Vercel credential isolation", () => {
  it("runs `vercel build` once, without any Vercel credential", () => {
    expect(buildSteps.map((step) => step.name)).toEqual([BUILD]);
    for (const step of buildSteps) {
      expect(step.text, step.name).not.toMatch(TOKEN);
      expect(step.text, step.name).not.toContain("secrets.");
    }
  });

  it("only exposes the token to steps that run nothing but `vercel pull`/`deploy`/`promote`", () => {
    expect(tokenSteps.map((step) => step.name)).toEqual([PULL, DEPLOY, PROMOTE, ALIAS]);
    for (const step of tokenSteps) {
      expect(step.run, step.name).not.toMatch(VERCEL_BUILD);
      expect(step.run, step.name).not.toMatch(RUNS_REPO_CODE);
      const cliCalls = step.run.match(/vercel@\$VERCEL_CLI_VERSION" [a-z]+/g) ?? [];
      for (const call of cliCalls) expect(call, step.name).toMatch(/" (pull|deploy|promote)$/);
      expect(cliCalls.length > 0 || step.run.includes("api.vercel.com"), step.name).toBe(true);
    }
  });

  it("never writes the token into GITHUB_ENV/GITHUB_OUTPUT or workflow/job-level env", () => {
    for (const step of tokenSteps) {
      for (const line of step.run.split("\n")) {
        if (/GITHUB_(ENV|OUTPUT|PATH)/.test(line)) expect(line, step.name).not.toMatch(TOKEN);
      }
    }
    expect(workflow.slice(0, workflow.indexOf("\n    steps:"))).not.toMatch(TOKEN);
  });

  it("runs staging-release.yml's exact token-persistence guard right after `vercel pull`", () => {
    const pull = steps[indexOf(BUILD) - 1]!;
    expect(pull.name).toBe(PULL);
    expect(pull.run).toMatch(/vercel@\$VERCEL_CLI_VERSION" pull/);
    expect(pull.run).toContain("# >>> token-persistence guard");
    expect(guardBlock(workflow)).toBe(guardBlock(read("staging-release.yml")));
  });
});
