import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Selection logic for .github/workflows/pr-preview-e2e.yml's "Resolve verified
 * Preview deployment URL" step (scripts/ci/select-staging-preview-deployment.mjs).
 * Fixtures mirror the exact GitHub deployment/status metadata Vercel's GitHub app
 * produced for syveka/syveka-ai PR #202 (both the staging and the production
 * project build every PR). Every guard must fail closed.
 */

const SCRIPT = path.join(__dirname, "../../scripts/ci/select-staging-preview-deployment.mjs");

type Resolver = {
  STAGING_PREVIEW_ENVIRONMENT: string;
  SelectionError: new (code: string) => Error & { code: string };
  stagingPreviewOrigin(value: unknown): string | null;
  assertPullRequest(pr: unknown, opts: Record<string, unknown>): { headRef: string };
  selectGithubDeployment(
    deployments: unknown,
    statusesById: unknown,
    opts: { expectedSha: string },
  ): { origin: string; deploymentId: number };
  assertVercelDeployment(vercel: unknown, opts: Record<string, unknown>): string;
  resolveStagingPreview(input: Record<string, unknown>): string;
  resolveFromApis(
    env: Record<string, string | undefined>,
    fetchImpl: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>,
  ): Promise<string>;
};

let r: Resolver;
beforeAll(async () => {
  r = (await import(pathToFileURL(SCRIPT).href)) as Resolver;
});

const REPO = "syveka/syveka-ai";
const SHA = "0534a5f48270c16dc849ae09c606189d58d3a33c";
const OTHER_SHA = "1d3ad4efa140d0a6912bae1f9e4012fa64414e67";
const PR = 202;
const BRANCH = "feat/email-voice-readiness-assistant-voice-mode";
const STAGING_PROJECT_ID = "prj_staging0000000000000000";
const PRODUCTION_PROJECT_ID = "prj_production00000000000000";
const STAGING_ENV = "Preview – syveka-ai-staging";
const PRODUCTION_PREVIEW_ENV = "Preview – syveka-ai-production";
const STAGING_URL = "https://syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app";
const PRODUCTION_PREVIEW_URL = "https://syveka-ai-production-2qxim7rmw-syveka-ai.vercel.app";

const bot = { login: "vercel[bot]", type: "Bot" };

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: 6683916324,
    sha: SHA,
    ref: SHA,
    task: "deploy",
    environment: STAGING_ENV,
    original_environment: STAGING_ENV,
    production_environment: false,
    transient_environment: false,
    creator: bot,
    payload: {},
    ...overrides,
  };
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    id: 18886334256,
    state: "success",
    environment: STAGING_ENV,
    environment_url: STAGING_URL,
    target_url: STAGING_URL,
    creator: bot,
    ...overrides,
  };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: PR,
    state: "open",
    head: { sha: SHA, ref: BRANCH, repo: { full_name: REPO } },
    base: { repo: { full_name: REPO } },
    ...overrides,
  };
}

function vercelRecord(overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    id: "dpl_x",
    url: new URL(STAGING_URL).hostname,
    projectId: STAGING_PROJECT_ID,
    target: null,
    readyState: "READY",
    meta: {
      githubCommitSha: SHA,
      githubCommitRef: BRANCH,
      githubPrId: String(PR),
      githubCommitOrg: "syveka",
      githubCommitRepo: "syveka-ai",
      ...meta,
    },
    ...overrides,
  };
}

/** Both projects' previews for the same PR commit — the real-world shape. */
function realWorldInput(overrides: Record<string, unknown> = {}) {
  const staging = deployment();
  const production = deployment({
    id: 6683930833,
    environment: PRODUCTION_PREVIEW_ENV,
    original_environment: PRODUCTION_PREVIEW_ENV,
  });
  return {
    repository: REPO,
    expectedSha: SHA,
    prNumber: PR,
    pr: pullRequest(),
    deployments: [production, staging],
    statusesById: {
      [staging.id]: [status()],
      [production.id]: [
        status({
          id: 18886365394,
          environment: PRODUCTION_PREVIEW_ENV,
          environment_url: PRODUCTION_PREVIEW_URL,
          target_url: PRODUCTION_PREVIEW_URL,
        }),
      ],
    },
    stagingProjectId: STAGING_PROJECT_ID,
    vercelDeploymentFor: (host: string) =>
      host === new URL(STAGING_URL).hostname ? vercelRecord() : null,
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but no error was thrown`);
}

describe("real-world selection", () => {
  it("selects the staging project's preview for PR #202 and never the production project's", () => {
    expect(r.resolveStagingPreview(realWorldInput())).toBe(STAGING_URL);
  });

  it("uses the exact en-dash environment label Vercel emits", () => {
    expect(r.STAGING_PREVIEW_ENVIRONMENT).toBe(STAGING_ENV);
    expect(r.STAGING_PREVIEW_ENVIRONMENT.codePointAt(8)).toBe(0x2013);
  });
});

describe("step 1 — pull request guards", () => {
  const opts = { repository: REPO, expectedSha: SHA, prNumber: PR };

  it("accepts the open same-repo PR whose head is the expected SHA", () => {
    expect(r.assertPullRequest(pullRequest(), opts)).toEqual({ headRef: BRANCH });
  });

  it.each([
    ["invalid expected SHA", pullRequest(), { expectedSha: "abc" }, "EXPECTED_SHA_INVALID"],
    ["invalid PR number", pullRequest(), { prNumber: Number.NaN }, "PR_NUMBER_INVALID"],
    ["a different PR", pullRequest({ number: 201 }), {}, "PR_NUMBER_MISMATCH"],
    ["a closed/merged PR", pullRequest({ state: "closed" }), {}, "PR_NOT_OPEN"],
    [
      "a moved PR head (another SHA)",
      pullRequest({ head: { sha: OTHER_SHA, ref: BRANCH, repo: { full_name: REPO } } }),
      {},
      "PR_HEAD_SHA_MISMATCH",
    ],
    [
      "a fork PR",
      pullRequest({ head: { sha: SHA, ref: BRANCH, repo: { full_name: "attacker/syveka-ai" } } }),
      {},
      "PR_REPOSITORY_MISMATCH",
    ],
    [
      "a PR in another repository",
      pullRequest({ base: { repo: { full_name: "other/repo" } } }),
      {},
      "PR_REPOSITORY_MISMATCH",
    ],
    [
      "a PR with no head branch",
      pullRequest({ head: { sha: SHA, ref: "", repo: { full_name: REPO } } }),
      {},
      "PR_HEAD_REF_MISSING",
    ],
  ])("rejects %s", (_label, pr, override, code) => {
    expectCode(() => r.assertPullRequest(pr, { ...opts, ...override }), code as string);
  });
});

describe("step 2 — GitHub deployment guards", () => {
  const opts = { expectedSha: SHA };
  const one = (d: Record<string, unknown>, s: Record<string, unknown>[] = [status()]) =>
    r.selectGithubDeployment([deployment(d)], { [(d.id as number) ?? 6683916324]: s }, opts);

  it("fails closed with zero deployments", () => {
    expectCode(() => r.selectGithubDeployment([], {}, opts), "NO_MATCHING_PREVIEW_DEPLOYMENT");
  });

  it.each([
    [
      "the production project's preview",
      { environment: PRODUCTION_PREVIEW_ENV, original_environment: PRODUCTION_PREVIEW_ENV },
    ],
    ["a Production deployment", { environment: "Production", original_environment: "Production" }],
    [
      'the bare legacy "Preview" label',
      { environment: "Preview", original_environment: "Preview" },
    ],
    [
      "a hyphen look-alike label",
      {
        environment: "Preview - syveka-ai-staging",
        original_environment: "Preview - syveka-ai-staging",
      },
    ],
    [
      "a relabelled deployment (original_environment differs)",
      { original_environment: "Production" },
    ],
    [
      "a deployment whose current environment was moved to Production",
      { environment: "Production" },
    ],
    ["production_environment true", { production_environment: true }],
    ["production_environment missing", { production_environment: undefined }],
    ["another SHA", { sha: OTHER_SHA }],
    ["a non-deploy task", { task: "deploy:migrations" }],
    ["a deployment created by a user, not Vercel", { creator: { login: "someone", type: "User" } }],
    ["a bot impersonating the Vercel login", { creator: { login: "vercel[bot]", type: "User" } }],
    [
      "a deployment created by a different bot/app",
      { creator: { login: "github-actions[bot]", type: "Bot" } },
    ],
  ])("never selects %s", (_label, d) => {
    expectCode(() => one(d), "NO_MATCHING_PREVIEW_DEPLOYMENT");
  });

  it.each([
    [
      "latest status is not success (older success superseded)",
      [status({ id: 1 }), status({ id: 2, state: "failure" })],
    ],
    ["latest status is inactive", [status({ id: 1 }), status({ id: 5, state: "inactive" })]],
    ["no statuses", []],
    [
      "status posted by someone other than Vercel",
      [status({ creator: { login: "someone", type: "User" } })],
    ],
    ["status for a different environment", [status({ environment: PRODUCTION_PREVIEW_ENV })]],
    [
      "status URL on the production project's host",
      [status({ environment_url: PRODUCTION_PREVIEW_URL, target_url: PRODUCTION_PREVIEW_URL })],
    ],
    [
      "status URL on an arbitrary host",
      [
        status({
          environment_url: "https://evil.example.com",
          target_url: "https://evil.example.com",
        }),
      ],
    ],
  ])("fails closed when %s", (_label, statuses) => {
    expectCode(() => one({}, statuses), "NO_CURRENT_SUCCESSFUL_PREVIEW_DEPLOYMENT_STATUS");
  });

  it("uses the highest status id, not array order", () => {
    const statuses = [status({ id: 9 }), status({ id: 3, state: "failure" })];
    expect(one({}, statuses).origin).toBe(STAGING_URL);
  });

  it("fails closed on two distinct staging preview URLs for the same commit (ambiguous)", () => {
    const a = deployment({ id: 1 });
    const b = deployment({ id: 2 });
    const other = "https://syveka-ai-staging-zzz999-syveka-ai.vercel.app";
    expectCode(
      () =>
        r.selectGithubDeployment(
          [a, b],
          { 1: [status()], 2: [status({ environment_url: other, target_url: other })] },
          opts,
        ),
      "AMBIGUOUS_PREVIEW_DEPLOYMENTS",
    );
  });

  it("treats two records for the same URL as one match", () => {
    const a = deployment({ id: 1 });
    const b = deployment({ id: 2 });
    expect(r.selectGithubDeployment([a, b], { 1: [status()], 2: [status()] }, opts).origin).toBe(
      STAGING_URL,
    );
  });

  it("rejects non-array deployment data", () => {
    expectCode(() => r.selectGithubDeployment({} as never, {}, opts), "DEPLOYMENTS_INVALID");
  });
});

describe("staging preview origin validation", () => {
  it.each([
    [STAGING_URL, STAGING_URL],
    [`${STAGING_URL}/`, STAGING_URL],
    [PRODUCTION_PREVIEW_URL, null],
    ["https://syveka-ai-staging.vercel.app", null], // floating alias, not a per-deployment URL
    ["https://syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app.evil.com", null],
    ["https://evilsyveka-ai-staging-f3ued7t46-syveka-ai.vercel.app", null],
    ["https://syveka-ai-staging-f3ued7t46-other-team.vercel.app", null],
    ["http://syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app", null],
    ["https://user:pw@syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app", null],
    ["https://syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app:8443", null],
    ["https://syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app/path", null],
    ["https://syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app/?x=1", null],
    ["https://syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app/#h", null],
    ["not a url", null],
    ["", null],
    [undefined, null],
  ])("%s → %s", (input, expected) => {
    expect(r.stagingPreviewOrigin(input)).toBe(expected);
  });
});

describe("step 3 — Vercel project/commit/branch guards", () => {
  const opts = {
    origin: STAGING_URL,
    expectedSha: SHA,
    stagingProjectId: STAGING_PROJECT_ID,
    headRef: BRANCH,
    prNumber: PR,
    repository: REPO,
  };

  it("accepts the staging project's READY preview built from the PR commit", () => {
    expect(r.assertVercelDeployment(vercelRecord(), opts)).toBe(STAGING_URL);
  });

  it("accepts a record without githubPrId (branch + SHA still pinned)", () => {
    expect(r.assertVercelDeployment(vercelRecord({}, { githubPrId: undefined }), opts)).toBe(
      STAGING_URL,
    );
  });

  it("accepts the alternative githubOrg/githubRepo meta spelling", () => {
    const rec = vercelRecord(
      {},
      {
        githubCommitOrg: undefined,
        githubCommitRepo: undefined,
        githubOrg: "syveka",
        githubRepo: "syveka-ai",
      },
    );
    expect(r.assertVercelDeployment(rec, opts)).toBe(STAGING_URL);
  });

  it.each([
    ["no Vercel record", null, {}, "VERCEL_DEPLOYMENT_MISSING"],
    [
      "missing staging project id config",
      vercelRecord(),
      { stagingProjectId: "" },
      "STAGING_PROJECT_ID_MISSING",
    ],
    [
      "the production project",
      vercelRecord({ projectId: PRODUCTION_PROJECT_ID }),
      {},
      "VERCEL_PROJECT_MISMATCH",
    ],
    [
      "a production target",
      vercelRecord({ target: "production" }),
      {},
      "VERCEL_TARGET_NOT_PREVIEW",
    ],
    [
      "a staging-alias target",
      vercelRecord({ target: "staging" }),
      {},
      "VERCEL_TARGET_NOT_PREVIEW",
    ],
    [
      "a deployment still building",
      vercelRecord({ readyState: "BUILDING" }),
      {},
      "VERCEL_DEPLOYMENT_NOT_READY",
    ],
    [
      "a failed deployment",
      vercelRecord({ readyState: "ERROR" }),
      {},
      "VERCEL_DEPLOYMENT_NOT_READY",
    ],
    [
      "a different deployment URL",
      vercelRecord({ url: "syveka-ai-staging-other1-syveka-ai.vercel.app" }),
      {},
      "VERCEL_URL_MISMATCH",
    ],
    [
      "another commit",
      vercelRecord({}, { githubCommitSha: OTHER_SHA }),
      {},
      "VERCEL_COMMIT_SHA_MISMATCH",
    ],
    ["no commit metadata", vercelRecord({ meta: {} }), {}, "VERCEL_COMMIT_SHA_MISMATCH"],
    ["no meta at all", vercelRecord({ meta: undefined }), {}, "VERCEL_COMMIT_SHA_MISMATCH"],
    ["another branch", vercelRecord({}, { githubCommitRef: "main" }), {}, "VERCEL_BRANCH_MISMATCH"],
    [
      "no branch metadata",
      vercelRecord({}, { githubCommitRef: undefined }),
      {},
      "VERCEL_BRANCH_MISMATCH",
    ],
    ["another PR", vercelRecord({}, { githubPrId: "201" }), {}, "VERCEL_PR_MISMATCH"],
    [
      "another repository",
      vercelRecord({}, { githubCommitRepo: "other-repo" }),
      {},
      "VERCEL_REPOSITORY_MISMATCH",
    ],
    [
      "another org",
      vercelRecord({}, { githubCommitOrg: "attacker" }),
      {},
      "VERCEL_REPOSITORY_MISMATCH",
    ],
    [
      "no repository metadata",
      vercelRecord({}, { githubCommitOrg: undefined, githubCommitRepo: undefined }),
      {},
      "VERCEL_REPOSITORY_MISMATCH",
    ],
  ])("fails closed on %s", (_label, rec, override, code) => {
    expectCode(() => r.assertVercelDeployment(rec, { ...opts, ...override }), code as string);
  });
});

describe("resolveFromApis — network orchestration", () => {
  const env = {
    GITHUB_REPOSITORY_FULL: REPO,
    EXPECTED_SHA: SHA,
    PR_NUMBER: String(PR),
    GH_TOKEN: "gh-test-token",
    STAGING_VERCEL_TOKEN: "vercel-test-token",
    STAGING_VERCEL_PROJECT_ID: STAGING_PROJECT_ID,
    STAGING_VERCEL_ORG_ID: "team_test",
  };

  function fakeApis(overrides: { pr?: unknown; vercel?: unknown } = {}) {
    const input = realWorldInput();
    const calls: Array<{ url: string; auth?: string }> = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, auth: init?.headers?.Authorization });
      const u = new URL(url);
      if (u.hostname === "api.vercel.com") return json(overrides.vercel ?? vercelRecord());
      if (u.pathname.endsWith(`/pulls/${PR}`)) return json(overrides.pr ?? input.pr);
      if (u.pathname.endsWith("/deployments")) return json(input.deployments);
      const m = u.pathname.match(/deployments\/(\d+)\/statuses$/);
      if (m) return json((input.statusesById as Record<string, unknown>)[m[1]!]);
      return new Response("not found", { status: 404 });
    });
    return { fetchImpl, calls };
  }

  it("resolves end to end and sends each token only to its own API", async () => {
    const { fetchImpl, calls } = fakeApis();
    await expect(r.resolveFromApis(env, fetchImpl)).resolves.toBe(STAGING_URL);
    for (const call of calls) {
      const host = new URL(call.url).hostname;
      if (host === "api.github.com") expect(call.auth).toBe("Bearer gh-test-token");
      else if (host === "api.vercel.com") expect(call.auth).toBe("Bearer vercel-test-token");
      else throw new Error(`unexpected host ${host}`);
    }
    const vercelCalls = calls.filter((c) => c.url.startsWith("https://api.vercel.com"));
    expect(vercelCalls).toHaveLength(1);
    expect(vercelCalls[0]!.url).toBe(
      "https://api.vercel.com/v13/deployments/syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app?teamId=team_test",
    );
    // Production-project statuses are never even fetched.
    expect(calls.some((c) => c.url.includes("/deployments/6683930833/"))).toBe(false);
  });

  it("validates the PR before making any Vercel call", async () => {
    const { fetchImpl, calls } = fakeApis({ pr: pullRequest({ state: "closed" }) });
    await expect(r.resolveFromApis(env, fetchImpl)).rejects.toMatchObject({ code: "PR_NOT_OPEN" });
    expect(calls.some((c) => c.url.startsWith("https://api.vercel.com"))).toBe(false);
  });

  it.each(["STAGING_VERCEL_TOKEN", "STAGING_VERCEL_PROJECT_ID", "STAGING_VERCEL_ORG_ID"])(
    "fails closed before any network call when %s is missing",
    async (key) => {
      const { fetchImpl } = fakeApis();
      await expect(r.resolveFromApis({ ...env, [key]: "" }, fetchImpl)).rejects.toMatchObject({
        code: "STAGING_VERCEL_CONFIG_MISSING",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("fails closed when Vercel says the host belongs to another project", async () => {
    const { fetchImpl } = fakeApis({ vercel: vercelRecord({ projectId: PRODUCTION_PROJECT_ID }) });
    await expect(r.resolveFromApis(env, fetchImpl)).rejects.toMatchObject({
      code: "VERCEL_PROJECT_MISMATCH",
    });
  });

  it("fails closed on API errors", async () => {
    const failing = vi.fn(async () => new Response("", { status: 500 }));
    await expect(r.resolveFromApis(env, failing)).rejects.toMatchObject({
      code: "GITHUB_API_FAILED",
    });
  });
});

describe("CLI", () => {
  it("exits non-zero with a bare error code and no stdout when configuration is missing", () => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, [SCRIPT], {
        // Deliberately minimal: no tokens, so the resolver must fail closed.
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          EXPECTED_SHA: SHA,
          PR_NUMBER: "202",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      exitCode = e.status;
      stdout = e.stdout;
      stderr = e.stderr;
    }
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe("STAGING_VERCEL_CONFIG_MISSING");
  });
});
