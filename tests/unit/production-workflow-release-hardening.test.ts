import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * deploy.yml once reported success for a release that never went live: the
 * production project does not auto-assign its domains, so `vercel deploy
 * --prod` left the candidate STAGED while the old deployment kept serving,
 * and the post-deploy check (HTTP 200 on vars.PROD_URL, no SHA) passed
 * against the old build. It also exposed VERCEL_TOKEN to `vercel build`,
 * which runs application code. These invariants keep both from recurring.
 */
const workflowPath = path.join(__dirname, "../../.github/workflows/deploy.yml");
const workflow = fs.readFileSync(workflowPath, "utf8").replace(/\r\n?/g, "\n");

type Step = { name: string; text: string; run: string };

const steps: Step[] = workflow
  .split("\n      - name: ")
  .slice(1)
  .map((chunk) => {
    const name = chunk.split("\n")[0]!.trim();
    const runMatch = chunk.match(/\n        run: (?:\|\n)?([\s\S]*?)(?=\n        [a-z-]+:|$)/);
    return { name, text: chunk, run: runMatch?.[1] ?? "" };
  });

function step(name: string): Step {
  const found = steps.find((s) => s.name === name);
  if (!found) throw new Error(`deploy.yml is missing the step "${name}"`);
  return found;
}

const indexOf = (name: string) => steps.indexOf(step(name));

const TOKEN = /VERCEL_TOKEN|--token/;
const VERCEL_BUILD = /vercel@\$VERCEL_CLI_VERSION" build\b|\bvercel build\b/;
const RUNS_REPO_CODE =
  /\bnpm (ci|install|test|run)\b|\bnpx (tsx|playwright|prisma|next)\b|\bnode (--env-file|scripts\/|-e)|\bnext build\b|\bpsql\b/;
const CANDIDATE_SHA = "${{ needs.verify-release-chain.outputs.candidate_sha }}";

const BUILD = "Build immutable production deployment (no Vercel credentials)";
const PULL = "Pull production config (Vercel credentials)";
const PREVIOUS = "Record the current production deployment (Vercel credentials)";
const DEPLOY = "Deploy the candidate as a staged production deployment (Vercel credentials)";
const VERIFY_STAGED = "Verify the staged candidate deployment (Vercel credentials)";
const PRE_PROMOTION = "Check the staged candidate before promotion";
const PROMOTE = "Promote the verified candidate (Vercel credentials)";
const VERIFY_DOMAINS = "Verify the production domains point at the candidate (Vercel credentials)";
const PROVE_SERVED = "Prove the production domains serve the candidate build";
const ROLLBACK_HINT = "Print the rollback command";

// Real token use (env binding or CLI flag), not the word in a YAML comment.
const tokenSteps = steps.filter((s) => /secrets\.VERCEL_TOKEN|--token/.test(s.text));

describe("deploy.yml Vercel credential isolation", () => {
  it("runs `vercel build` exactly once, with no Vercel credential", () => {
    const buildSteps = steps.filter((s) => VERCEL_BUILD.test(s.run));
    expect(buildSteps.map((s) => s.name)).toEqual([BUILD]);
    expect(step(BUILD).text).not.toMatch(TOKEN);
    expect(step(BUILD).text).not.toContain("secrets.");
  });

  it("only gives the token to steps that run the Vercel CLI or read-only Vercel API calls", () => {
    expect(tokenSteps.map((s) => s.name)).toEqual([
      PULL,
      PREVIOUS,
      DEPLOY,
      VERIFY_STAGED,
      PROMOTE,
      VERIFY_DOMAINS,
    ]);
    for (const s of tokenSteps) {
      expect(s.run, s.name).not.toMatch(VERCEL_BUILD);
      expect(s.run, s.name).not.toMatch(RUNS_REPO_CODE);
      for (const call of s.run.match(/vercel@\$VERCEL_CLI_VERSION" [a-z]+/g) ?? []) {
        expect(call, s.name).toMatch(/" (pull|deploy|promote)$/);
      }
      for (const [, host] of s.run.matchAll(/https:\/\/([a-z0-9.-]+)/g)) {
        expect(host, s.name).toBe("api.vercel.com");
      }
    }
  });

  it("never writes the token into GITHUB_ENV/GITHUB_OUTPUT or workflow/job-level env", () => {
    for (const s of tokenSteps) {
      for (const line of s.run.split("\n")) {
        if (/GITHUB_(ENV|OUTPUT|PATH)/.test(line)) expect(line, s.name).not.toMatch(TOKEN);
      }
    }
    expect(workflow.slice(0, workflow.indexOf("\n    steps:"))).not.toMatch(TOKEN);
  });

  it("checks that `vercel pull` did not persist the token before building", () => {
    expect(indexOf(PULL)).toBe(indexOf(BUILD) - 1);
    expect(step(PULL).run).toContain('grep -rqsF -- "$VERCEL_TOKEN" .vercel');
  });
});

describe("deploy.yml verified promotion", () => {
  it("builds the candidate SHA into /api/health and pins the canonical domain", () => {
    expect(step(BUILD).text).toContain(`NEXT_PUBLIC_BUILD_SHA: ${CANDIDATE_SHA}`);
    expect(step(BUILD).run).toContain('if [ "$app_url" != "$PROD_CANONICAL_URL" ]');
    expect(workflow).toContain("  PROD_CANONICAL_URL: https://syveka.com\n");
  });

  it("deploys staged, verifies, promotes, then proves the domains serve the candidate -- in that order", () => {
    const order = [
      PULL,
      BUILD,
      PREVIOUS,
      DEPLOY,
      VERIFY_STAGED,
      PRE_PROMOTION,
      PROMOTE,
      VERIFY_DOMAINS,
      PROVE_SERVED,
      ROLLBACK_HINT,
    ].map(indexOf);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.at(-1)).toBe(steps.length - 1);
  });

  it("never lets `vercel deploy --prod` assign domains implicitly", () => {
    const deploys = steps.filter((s) => /vercel@\$VERCEL_CLI_VERSION" deploy\b/.test(s.run));
    expect(deploys.map((s) => s.name)).toEqual([DEPLOY]);
    expect(step(DEPLOY).run).toContain("deploy --prebuilt --prod --skip-domain");
  });

  it("requires the staged deployment to be this project's READY, STAGED build of the candidate SHA", () => {
    const run = step(VERIFY_STAGED).run;
    expect(run).toContain('[ "$ready_state" != "READY" ]');
    expect(run).toContain('[ "$ready_substate" != "STAGED" ]');
    expect(run).toContain('[ "$target" != "production" ]');
    expect(run).toContain('[ "$commit_sha" != "$CANDIDATE_SHA" ]');
    expect(run).toContain('[ "$project_id" != "$VERCEL_PROJECT_ID" ]');
    expect(step(VERIFY_STAGED).text).toContain(`CANDIDATE_SHA: ${CANDIDATE_SHA}`);
  });

  it("checks the staged build's health and SHA through the bypass header, failing closed without it", () => {
    const run = step(PRE_PROMOTION).run;
    expect(run).toContain('if [ -z "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]');
    expect(run).toContain('-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"');
    expect(run).toContain('"$DEPLOYMENT_URL/api/health"');
    expect(run).toContain('\\"build\\":\\"$CANDIDATE_SHA\\"');
  });

  it("promotes exactly the verified deployment id", () => {
    expect(step(PROMOTE).run).toContain('promote "$CANDIDATE_DEPLOYMENT_ID"');
    expect(step(PROMOTE).text).toContain(
      "CANDIDATE_DEPLOYMENT_ID: ${{ steps.candidate.outputs.id }}",
    );
  });

  it("fails if the candidate is still STAGED or either production domain points elsewhere", () => {
    const run = step(VERIFY_DOMAINS).run;
    expect(run).toContain('[ "$ready_substate" != "PROMOTED" ]');
    expect(run).toContain('[ "$live_id" != "$CANDIDATE_DEPLOYMENT_ID" ]');
    expect(run).toContain('for domain in "${PROD_CANONICAL_URL#https://}" "${PROD_URL#https://}"');
    expect(run).toContain('[ "$aliased_id" != "$CANDIDATE_DEPLOYMENT_ID" ]');
  });

  it("requires both production domains to serve a healthy build of the candidate SHA", () => {
    const run = step(PROVE_SERVED).run;
    expect(run).toContain('for base_url in "$PROD_CANONICAL_URL" "$PROD_URL"');
    expect(run).toContain('\\"status\\":\\"healthy\\"');
    expect(run).toContain('\\"build\\":\\"$CANDIDATE_SHA\\"');
  });

  it("has no step that can mask a failed release", () => {
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toContain("Post-deploy synthetic check");
    expect(step(ROLLBACK_HINT).text).toContain("if: failure() && steps.previous.outputs.id != ''");
  });
});
