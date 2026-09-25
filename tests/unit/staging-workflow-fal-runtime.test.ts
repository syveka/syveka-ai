import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Staging Creator Studio runtime config: the GitHub `staging` environment
 * secret STAGING_FAL_API_KEY must reach both staging deployments as the
 * runtime FAL_API_KEY (via `vercel deploy --env`), be proven present by name
 * only, and never be exposed to a step that runs repository code, written to
 * disk/GITHUB_ENV/GITHUB_OUTPUT, printed, or referenced by the production
 * release workflow.
 */
const read = (file: string) =>
  fs
    .readFileSync(path.join(__dirname, "../../.github/workflows", file), "utf8")
    .replace(/\r\n?/g, "\n");
const workflow = read("staging-release.yml");

type Step = { name: string; text: string; run: string };
const steps: Step[] = workflow
  .split("\n      - name: ")
  .slice(1)
  .map((chunk) => {
    const name = chunk.split("\n")[0]!.trim();
    const runMatch = chunk.match(/\n        run: (?:\|\n)?([\s\S]*?)(?=\n        [a-z-]+:|$)/);
    return { name, text: chunk, run: runMatch?.[1] ?? "" };
  });

const DEPLOY_STEPS = [
  "Deploy staging application",
  "Deploy validated candidate to the stable staging alias",
];
const step = (name: string) => steps.find((s) => s.name === name)!;

describe("staging-release.yml runtime FAL_API_KEY", () => {
  it("exposes STAGING_FAL_API_KEY only to the config check and the two deploy steps", () => {
    const withSecret = steps
      .filter((s) => s.text.includes("STAGING_FAL_API_KEY"))
      .map((s) => s.name);
    expect(withSecret).toEqual(["Verify Creator Studio provider configuration", ...DEPLOY_STEPS]);
  });

  it.each(DEPLOY_STEPS)("%s refuses an empty or multi-line secret before deploying", (name) => {
    const run = step(name).run;
    const guard = run.indexOf('if [ -z "$STAGING_FAL_API_KEY" ]');
    expect(guard).toBeGreaterThan(-1);
    expect(run).toContain(`*$'\\n'*`);
    expect(run).toContain(`*$'\\r'*`);
    expect(guard).toBeLessThan(run.indexOf("deploy --prebuilt"));
  });

  it.each(DEPLOY_STEPS)("%s passes the secret as the runtime FAL_API_KEY", (name) => {
    expect(step(name).run).toMatch(
      /vercel@\$VERCEL_CLI_VERSION" deploy --prebuilt (--prod )?--env "FAL_API_KEY=\$STAGING_FAL_API_KEY"/,
    );
  });

  it.each(DEPLOY_STEPS)(
    "%s fails closed unless the new deployment reports FAL_API_KEY by name",
    (name) => {
      const run = step(name).run;
      const deploy = run.indexOf("deploy --prebuilt");
      const lookup = run.indexOf("https://api.vercel.com/v13/deployments/");
      const check = run.indexOf(`jq -e '(.env // []) | index("FAL_API_KEY") != null'`);
      expect(lookup).toBeGreaterThan(deploy);
      expect(check).toBeGreaterThan(lookup);
      expect(run.slice(check)).toMatch(/refusing to continue\."\n\s+exit 1/);
    },
  );

  it("never prints, persists or forwards the secret value", () => {
    for (const s of steps) {
      for (const line of s.run.split("\n")) {
        // Lines that expand the value (error messages may name the variable).
        if (!/\$\{?STAGING_FAL_API_KEY/.test(line)) continue;
        expect(line, s.name).not.toMatch(/\b(echo|printf|tee)\b/);
        expect(line, s.name).not.toMatch(/GITHUB_(ENV|OUTPUT|PATH)|>>?\s*[^&]/);
      }
    }
    expect(workflow.slice(0, workflow.indexOf("\n    steps:"))).not.toContain(
      "STAGING_FAL_API_KEY",
    );
  });

  it("keeps every build step free of the secret (builds run repository code)", () => {
    for (const s of steps.filter((x) => /" build\b/.test(x.run))) {
      expect(s.text, s.name).not.toContain("FAL_API_KEY");
    }
  });

  it("does not touch the production release workflow", () => {
    expect(read("deploy.yml")).not.toMatch(/STAGING_FAL_API_KEY|--env "FAL_API_KEY/);
  });
});
