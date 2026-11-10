import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Vercel-native "TypeCheck" deployment check on syveka-ai-staging runs
 * `npm run typecheck` in the deployment's uploaded files. A `vercel deploy
 * --prebuilt` upload holds only package.json and the build's traced files,
 * not tsconfig.json, so on every CLI deployment `tsc --noEmit` prints its
 * help text and exits 1 without checking anything (23 of 23 CLI deployments,
 * 2026-10-25 to 2026-11-03). That check therefore cannot vouch for what the
 * staging workflows deploy. These invariants are what does: every prebuilt
 * deployment is type-checked before upload, by `next build` inside `vercel
 * build`, and the staging release also runs `npm run typecheck` on the code
 * it deploys. The Vercel dashboard's Build Command must stay at its default
 * for `vercel build` to run the `build` script; the repository cannot pin
 * that setting. See docs/vercel-typecheck-check-cli-deployments.md.
 */
const root = path.join(__dirname, "../..");
const read = (file: string) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n?/g, "\n");

// Any spelling of the Vercel CLI (`vercel`, `vercel@x`, `"vercel@$V"`), flags in any order.
const VERCEL_CLI = String.raw`\bvercel(?:@[^\s"]+)?"?\s+`;
const PREBUILT_DEPLOY = new RegExp(String.raw`${VERCEL_CLI}deploy\b.*\s--prebuilt\b`);
const VERCEL_BUILD = new RegExp(String.raw`${VERCEL_CLI}build\b`);
const TYPECHECK = /\bnpm run typecheck\b/;
const CHECKOUT = /uses: actions\/checkout@/;

/** Lines matching `pattern`; YAML comment lines never count (they mention these commands). */
function linesMatching(lines: string[], pattern: RegExp): number[] {
  return lines.flatMap((line, i) => (!/^\s*#/.test(line) && pattern.test(line) ? [i] : []));
}

/** The job id (a two-space-indented key under `jobs:`) that contains `line`. */
function jobOf(lines: string[], line: number): string {
  for (let i = line; i >= 0; i--) {
    if (/^jobs:\s*$/.test(lines[i]!)) break;
    const match = lines[i]!.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) return match[1]!;
  }
  throw new Error(`line ${line + 1} is not inside a job`);
}

/** 1-based lines of a prebuilt deployment with no earlier `vercel build` in the same job. */
function prebuiltDeploysWithoutBuild(workflow: string): number[] {
  const lines = workflow.split("\n");
  const builds = linesMatching(lines, VERCEL_BUILD);
  return linesMatching(lines, PREBUILT_DEPLOY)
    .filter((deploy) => {
      const job = jobOf(lines, deploy);
      return !builds.some((b) => b < deploy && jobOf(lines, b) === job);
    })
    .map((deploy) => deploy + 1);
}

/** Whether `npm run typecheck` runs before the first prebuilt deployment, in its job. */
function typechecksBeforeFirstDeploy(workflow: string): boolean {
  const lines = workflow.split("\n");
  const firstDeploy = linesMatching(lines, PREBUILT_DEPLOY)[0];
  if (firstDeploy === undefined) return false;
  return linesMatching(lines, TYPECHECK).some(
    (t) => t < firstDeploy && jobOf(lines, t) === jobOf(lines, firstDeploy),
  );
}

describe("the build that `vercel build` runs type-checks", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("tsconfig.json is at the repository root, where `npm run typecheck` runs", () => {
    expect(fs.existsSync(path.join(root, "tsconfig.json"))).toBe(true);
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
  });

  it("`build` runs a full `next build`, and no `vercel-build` script replaces it", () => {
    expect(pkg.scripts.build).toMatch(/\bnext build\b/);
    expect(pkg.scripts.build).not.toMatch(/--experimental-build-mode|--no-lint/);
    expect(pkg.scripts["vercel-build"]).toBeUndefined();
  });

  it("vercel.json does not override the build command", () => {
    const vercel = JSON.parse(read("vercel.json")) as Record<string, unknown>;
    expect(vercel.buildCommand).toBeUndefined();
  });

  it("next.config does not ignore TypeScript errors", () => {
    expect(read("next.config.ts")).not.toMatch(/ignoreBuildErrors/);
  });
});

describe.each(["staging-release.yml", "staging-deploy-only.yml", "deploy.yml"])(
  "%s: every prebuilt deployment was type-checked before upload",
  (file) => {
    const workflow = read(`.github/workflows/${file}`);

    it("deploys with --prebuilt (the case the Vercel-native check cannot run on)", () => {
      expect(workflow).toMatch(PREBUILT_DEPLOY);
    });

    it("each prebuilt deployment follows a `vercel build` (which runs next build) in the same job", () => {
      expect(prebuiltDeploysWithoutBuild(workflow)).toEqual([]);
    });
  },
);

describe("staging-release.yml type-checks the code it deploys", () => {
  const workflow = read(".github/workflows/staging-release.yml");
  const lines = workflow.split("\n");

  it("runs `npm run typecheck` before its first prebuilt deployment, in the same job", () => {
    expect(typechecksBeforeFirstDeploy(workflow)).toBe(true);
  });

  it("checks out once, before the typecheck, so the typecheck and the deployment are the same code", () => {
    const checkouts = linesMatching(lines, CHECKOUT);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!).toBeLessThan(linesMatching(lines, TYPECHECK)[0]!);
  });
});

describe("the checks above catch a workflow that breaks them (synthetic workflows)", () => {
  const job = (name: string, ...runs: string[]) =>
    [`  ${name}:`, "    steps:", ...runs.map((r) => `      - run: ${r}`)].join("\n");
  const typecheck = "npm run typecheck";
  const build = 'npx --yes "vercel@$VERCEL_CLI_VERSION" build --prod';
  const deploy = 'url=$(npx --yes "vercel@$VERCEL_CLI_VERSION" deploy --prebuilt --prod)';
  const wf = (...jobs: string[]) => ["on:", "  push:", "jobs:", ...jobs].join("\n");

  it("a prebuilt deployment with no build is reported", () => {
    expect(prebuiltDeploysWithoutBuild(wf(job("ship", deploy)))).toEqual([6]);
  });

  it("other spellings of the deployment are recognised (reordered flags, bare `vercel`)", () => {
    expect(
      prebuiltDeploysWithoutBuild(wf(job("a", "npx vercel deploy --prod --prebuilt"))),
    ).toEqual([6]);
    expect(prebuiltDeploysWithoutBuild(wf(job("a", "vercel@56.3.2 deploy --prebuilt")))).toEqual([
      6,
    ]);
  });

  it("a build in another job does not count, including job ids with underscores", () => {
    expect(prebuiltDeploysWithoutBuild(wf(job("build", build), job("ship_it", deploy)))).toEqual([
      9,
    ]);
  });

  it("a build after the deployment does not count", () => {
    expect(prebuiltDeploysWithoutBuild(wf(job("ship", deploy, build)))).toEqual([6]);
  });

  it("a comment that mentions `vercel build` is not a build", () => {
    const commented = [
      "  ship:",
      "    steps:",
      "      # `vercel build` runs next build",
      `      - run: ${deploy}`,
    ];
    expect(prebuiltDeploysWithoutBuild(["jobs:", ...commented].join("\n"))).toEqual([5]);
  });

  it("a build before the deployment in the same job passes", () => {
    expect(prebuiltDeploysWithoutBuild(wf(job("ship", build, deploy)))).toEqual([]);
  });

  it("a typecheck that is missing, after the deployment, or in another job is reported", () => {
    expect(typechecksBeforeFirstDeploy(wf(job("ship", build, deploy)))).toBe(false);
    expect(typechecksBeforeFirstDeploy(wf(job("ship", build, deploy, typecheck)))).toBe(false);
    expect(typechecksBeforeFirstDeploy(wf(job("check", typecheck), job("ship", deploy)))).toBe(
      false,
    );
    expect(typechecksBeforeFirstDeploy(wf(job("ship", typecheck, build, deploy)))).toBe(true);
  });

  it("a step outside any job is an error, not a silent pass", () => {
    expect(() =>
      prebuiltDeploysWithoutBuild(["jobs:", `      - run: ${deploy}`].join("\n")),
    ).toThrow(/not inside a job/);
  });
});
