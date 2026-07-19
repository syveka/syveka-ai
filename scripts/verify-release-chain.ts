import { appendFileSync } from "node:fs";

type WorkflowRun = {
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
};

type WorkflowRunsResponse = { workflow_runs?: WorkflowRun[] };
type GitRefResponse = { object?: { sha?: string } };

export type ReleaseEnvironment = {
  CANDIDATE_SHA?: string;
  CONFIRM_PRODUCTION_SHA?: string;
  RELEASE_REPOSITORY?: string;
  RELEASE_GITHUB_TOKEN?: string;
  RELEASE_API_URL?: string;
  RELEASE_MAIN_BRANCH?: string;
  RELEASE_CI_WORKFLOW?: string;
  RELEASE_STAGING_WORKFLOW?: string;
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
    throw new Error(`GitHub release-chain query failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

function successfulRunFor(
  response: WorkflowRunsResponse,
  candidateSha: string,
  mainBranch: string,
  event: "push" | "workflow_dispatch",
): boolean {
  return (response.workflow_runs ?? []).some(
    (run) =>
      run.head_sha === candidateSha &&
      run.head_branch === mainBranch &&
      run.event === event &&
      run.status === "completed" &&
      run.conclusion === "success",
  );
}

export async function verifyReleaseCandidate(
  env: ReleaseEnvironment,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const candidateSha = env.CANDIDATE_SHA ?? "";
  const confirmationSha = env.CONFIRM_PRODUCTION_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
    throw new Error("CANDIDATE_SHA must be an exact lowercase 40-character Git SHA.");
  }
  if (confirmationSha !== candidateSha) {
    throw new Error("Production confirmation must exactly match CANDIDATE_SHA.");
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
  const stagingWorkflow = env.RELEASE_STAGING_WORKFLOW ?? "staging-release.yml";
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
    throw new Error("The production candidate is not the current immutable main SHA.");
  }

  const workflowRuns = async (workflow: string) =>
    fetchJson<WorkflowRunsResponse>(
      fetchImpl,
      `${apiUrl}/repos/${encodedRepository}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${candidateSha}&status=success&per_page=100`,
      token,
    );

  const [ciRuns, stagingRuns] = await Promise.all([
    workflowRuns(ciWorkflow),
    workflowRuns(stagingWorkflow),
  ]);
  if (!successfulRunFor(ciRuns, candidateSha, mainBranch, "push")) {
    throw new Error("No successful main push CI run exists for CANDIDATE_SHA.");
  }
  if (!successfulRunFor(stagingRuns, candidateSha, mainBranch, "workflow_dispatch")) {
    throw new Error("No successful staging release validation exists for CANDIDATE_SHA.");
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `candidate_sha=${candidateSha}\n`, { encoding: "utf8" });
  }
  console.log(`Release chain verified for ${candidateSha}.`);
  return candidateSha;
}

if (process.argv[1]?.endsWith("verify-release-chain.ts")) {
  await verifyReleaseCandidate(process.env as ReleaseEnvironment);
}
