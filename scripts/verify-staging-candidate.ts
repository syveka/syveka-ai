import { appendFileSync } from "node:fs";

// Self-contained on purpose: scripts/verify-release-chain.ts, which has the
// same GitHub queries for production, is protected configuration, so nothing
// is exported from it for this script.

type WorkflowRun = {
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
};

type WorkflowRunsResponse = { workflow_runs?: WorkflowRun[] };
type GitRefResponse = { object?: { sha?: string } };

export type StagingCandidateEnvironment = {
  CANDIDATE_SHA?: string;
  CONFIRM_STAGING_SHA?: string;
  RELEASE_REPOSITORY?: string;
  RELEASE_GITHUB_TOKEN?: string;
  RELEASE_API_URL?: string;
  RELEASE_MAIN_BRANCH?: string;
  RELEASE_CI_WORKFLOW?: string;
  GITHUB_OUTPUT?: string;
};

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub staging-candidate query failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

/**
 * The staging counterpart of verifyReleaseCandidate: the commit about to be
 * released to staging must be the one the operator typed, must still be the
 * tip of main, and must have a successful main push CI run.
 *
 * staging-release.yml re-runs most of CI itself, but not the secret scan, the
 * migration upgrade and baseline jobs or the non-superuser RLS job, and it
 * never asked whether CI passed. Run this twice: before the Environment
 * approval, so the approver sees a verified candidate, and again after it, so
 * a merge to main during the wait stops the release instead of leaving
 * staging on a commit that is no longer main.
 */
export async function verifyStagingCandidate(
  env: StagingCandidateEnvironment,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const candidateSha = env.CANDIDATE_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
    throw new Error("CANDIDATE_SHA must be an exact lowercase 40-character Git SHA.");
  }
  if ((env.CONFIRM_STAGING_SHA ?? "") !== candidateSha) {
    throw new Error("Staging confirmation must exactly match CANDIDATE_SHA.");
  }

  const repository = env.RELEASE_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("RELEASE_REPOSITORY is invalid.");
  }
  const token = env.RELEASE_GITHUB_TOKEN ?? "";
  if (!token) throw new Error("RELEASE_GITHUB_TOKEN is required.");

  const apiUrl = new URL(env.RELEASE_API_URL ?? "https://api.github.com").origin;
  const mainBranch = env.RELEASE_MAIN_BRANCH ?? "main";
  const ciWorkflow = env.RELEASE_CI_WORKFLOW ?? "ci.yml";
  const encodedRepository = repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  const mainRef = await fetchJson<GitRefResponse>(
    fetchImpl,
    `${apiUrl}/repos/${encodedRepository}/git/ref/heads/${encodeURIComponent(mainBranch)}`,
    token,
  );
  if (mainRef.object?.sha !== candidateSha) {
    throw new Error("The staging candidate is not the current main SHA.");
  }

  const ciRuns = await fetchJson<WorkflowRunsResponse>(
    fetchImpl,
    `${apiUrl}/repos/${encodedRepository}/actions/workflows/${encodeURIComponent(ciWorkflow)}/runs?head_sha=${candidateSha}&status=success&per_page=100`,
    token,
  );
  const hasGreenMainPush = (ciRuns.workflow_runs ?? []).some(
    (run) =>
      run.head_sha === candidateSha &&
      run.head_branch === mainBranch &&
      run.event === "push" &&
      run.status === "completed" &&
      run.conclusion === "success",
  );
  if (!hasGreenMainPush) {
    throw new Error("No successful main push CI run exists for CANDIDATE_SHA.");
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `candidate_sha=${candidateSha}\n`, { encoding: "utf8" });
  }
  console.log(`Staging candidate verified for ${candidateSha}.`);
  return candidateSha;
}

if (process.argv[1]?.endsWith("verify-staging-candidate.ts")) {
  verifyStagingCandidate(process.env as StagingCandidateEnvironment).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
