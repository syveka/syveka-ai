import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * STAGING_VERCEL_TOKEN is a team-scoped Vercel credential: the staging and
 * production Vercel projects live in the same team, so the token could deploy
 * either. `vercel build` runs `next build`, which executes application code,
 * so the token must never be present while any repository code runs -- only
 * in steps that run nothing but the Vercel CLI's `pull`/`deploy`.
 */
const workflowPath = path.join(__dirname, "../../.github/workflows/staging-release.yml");
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

const TOKEN = /STAGING_VERCEL_TOKEN|VERCEL_TOKEN|--token/;
const VERCEL_BUILD = /vercel@\$VERCEL_CLI_VERSION" build\b|\bvercel build\b/;
// Anything that executes repository or dependency code (install scripts
// included), rather than only the pinned Vercel CLI.
const RUNS_REPO_CODE =
  /\bnpm (ci|install|test|run)\b|\bnpx (tsx|playwright|prisma|next)\b|\bnode (--env-file|scripts\/|-e)|\bnext build\b|\bpsql\b/;

const tokenSteps = steps.filter((step) => TOKEN.test(step.text));
const buildSteps = steps.filter((step) => VERCEL_BUILD.test(step.run));

describe("staging-release.yml Vercel credential isolation", () => {
  it("runs every `vercel build` (Preview and stable alias) without any Vercel credential", () => {
    expect(buildSteps.map((step) => step.name)).toEqual([
      "Build staging deployment (no Vercel credentials)",
      "Build validated candidate for the stable staging alias (no Vercel credentials)",
    ]);
    for (const step of buildSteps) {
      expect(step.text, step.name).not.toMatch(TOKEN);
      expect(step.text, step.name).not.toContain("secrets.");
    }
  });

  it("only exposes the token to steps that run nothing but `vercel pull`/`vercel deploy`", () => {
    expect(tokenSteps.length).toBeGreaterThanOrEqual(4);
    for (const step of tokenSteps) {
      expect(step.run, step.name).not.toMatch(VERCEL_BUILD);
      expect(step.run, step.name).not.toMatch(RUNS_REPO_CODE);
      const cliCalls = step.run.match(/vercel@\$VERCEL_CLI_VERSION" [a-z]+/g) ?? [];
      expect(cliCalls.length, step.name).toBeGreaterThan(0);
      for (const call of cliCalls) expect(call, step.name).toMatch(/" (pull|deploy)$/);
    }
  });

  it("never writes the token into GITHUB_ENV/GITHUB_OUTPUT or workflow/job-level env", () => {
    for (const step of tokenSteps) {
      for (const line of step.run.split("\n")) {
        if (/GITHUB_(ENV|OUTPUT|PATH)/.test(line)) expect(line, step.name).not.toMatch(TOKEN);
      }
    }
    const beforeSteps = workflow.slice(0, workflow.indexOf("\n    steps:"));
    expect(beforeSteps).not.toMatch(TOKEN);
  });

  it("checks that `vercel pull` did not persist the token before any build", () => {
    for (const build of buildSteps) {
      const buildIndex = steps.indexOf(build);
      const pull = steps[buildIndex - 1]!;
      expect(pull.run, build.name).toMatch(/vercel@\$VERCEL_CLI_VERSION" pull/);
      expect(pull.run, build.name).toContain('guard_token="$STAGING_VERCEL_TOKEN"');
      expect(pull.run, build.name).toContain("# >>> token-persistence guard");
      expect(pull.run, build.name).toContain('grep -qF -- "$guard_token"');
    }
  });
});
