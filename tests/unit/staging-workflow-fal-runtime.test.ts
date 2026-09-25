import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Staging Creator Studio runtime config: FAL_API_KEY comes from the staging
 * Vercel project's own (Sensitive) environment. `vercel deploy --prebuilt`
 * ignores `--env` (run 36176876155 proved it: the deployment's env names were
 * unchanged), so the workflow never forwards the GitHub secret to a deploy.
 * Both staging deploys must instead prove, by NAME only, that Vercel attached
 * FAL_API_KEY -- and the GitHub secret STAGING_FAL_API_KEY stays confined to
 * the config-presence check, never printed, persisted, or given to the
 * production release workflow.
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
  it("confines STAGING_FAL_API_KEY to the Creator Studio config check", () => {
    const withSecret = steps
      .filter((s) => s.text.includes("STAGING_FAL_API_KEY"))
      .map((s) => s.name);
    expect(withSecret).toEqual(["Verify Creator Studio provider configuration"]);
  });

  it.each(DEPLOY_STEPS)("%s does not pass FAL_API_KEY via the ignored --env flag", (name) => {
    const run = step(name).run;
    const commands = run
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(commands).toMatch(/vercel@\$VERCEL_CLI_VERSION" deploy --prebuilt /);
    expect(commands).not.toMatch(/--env\b|\s-e\s+"?FAL_API_KEY/);
  });

  it.each(DEPLOY_STEPS)(
    "%s fails closed unless the new deployment reports FAL_API_KEY by name",
    (name) => {
      const run = step(name).run;
      const deploy = run.indexOf("deploy --prebuilt");
      const lookup = run.indexOf("https://api.vercel.com/v13/deployments/");
      const check = run.indexOf(`jq -e '(.env // []) | index("FAL_API_KEY") != null'`);
      expect(deploy).toBeGreaterThan(-1);
      expect(lookup).toBeGreaterThan(deploy);
      expect(check).toBeGreaterThan(lookup);
      expect(run.slice(check)).toMatch(/refusing to continue\."\n\s+exit 1/);
    },
  );

  it.each(DEPLOY_STEPS)("%s never prints the deployment's environment response", (name) => {
    for (const line of step(name).run.split("\n")) {
      if (!line.includes("runtime_env")) continue;
      expect(line, name).not.toMatch(/\b(echo|printf|tee|cat)\b/);
    }
  });

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
