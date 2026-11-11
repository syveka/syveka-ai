import { describe, expect, it, vi } from "vitest";

import {
  verifyStagingCandidate,
  type StagingCandidateEnvironment,
} from "../../scripts/verify-staging-candidate";

const sha = "a".repeat(40);
const other = "b".repeat(40);
const baseEnv: StagingCandidateEnvironment = {
  CANDIDATE_SHA: sha,
  CONFIRM_STAGING_SHA: sha,
  RELEASE_REPOSITORY: "syveka/syveka-ai",
  RELEASE_GITHUB_TOKEN: "test-token",
  RELEASE_API_URL: "https://api.github.test",
  RELEASE_MAIN_BRANCH: "main",
  RELEASE_CI_WORKFLOW: "ci.yml",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const greenPush = {
  head_sha: sha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
};

function githubFetch(overrides?: { mainSha?: string; ci?: unknown[]; ciStatus?: number }) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/git/ref/heads/main")) {
      return response({ object: { sha: overrides?.mainSha ?? sha } });
    }
    if (url.includes("/workflows/ci.yml/")) {
      return response({ workflow_runs: overrides?.ci ?? [greenPush] }, overrides?.ciStatus ?? 200);
    }
    return response({}, 404);
  });
}

describe("staging release candidate", () => {
  it("accepts the confirmed current main SHA with a successful main push CI run", async () => {
    const fetchMock = githubFetch();
    await expect(verifyStagingCandidate(baseEnv, fetchMock)).resolves.toBe(sha);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ciUrl = String(fetchMock.mock.calls[1]![0]);
    expect(ciUrl).toContain(`head_sha=${sha}`);
    expect(ciUrl).toContain("status=success");
  });

  it("never asks for a staging run of the candidate: that run is what is being started", async () => {
    const fetchMock = githubFetch();
    await verifyStagingCandidate(baseEnv, fetchMock);
    for (const [input] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain("staging-release.yml");
    }
  });

  it.each([
    ["a branch name", "main"],
    ["a short SHA", sha.slice(0, 12)],
    ["an uppercase SHA", sha.toUpperCase()],
    ["nothing", undefined],
  ])("rejects %s as the candidate before querying GitHub", async (_name, candidate) => {
    const fetchMock = githubFetch();
    await expect(
      verifyStagingCandidate({ ...baseEnv, CANDIDATE_SHA: candidate }, fetchMock),
    ).rejects.toThrow("exact lowercase 40-character Git SHA");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a different SHA", other],
    ["nothing", undefined],
    ["a prefix", sha.slice(0, 39)],
  ])("rejects %s as the typed confirmation before querying GitHub", async (_name, confirm) => {
    const fetchMock = githubFetch();
    await expect(
      verifyStagingCandidate({ ...baseEnv, CONFIRM_STAGING_SHA: confirm }, fetchMock),
    ).rejects.toThrow("Staging confirmation must exactly match");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops when main moved after the candidate was chosen (a merge during the approval wait)", async () => {
    const fetchMock = githubFetch({ mainSha: other });
    await expect(verifyStagingCandidate(baseEnv, fetchMock)).rejects.toThrow(
      "not the current main SHA",
    );
    // The CI query is not reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no run at all", []],
    ["a failed run", [{ ...greenPush, conclusion: "failure" }]],
    ["a run still in progress", [{ ...greenPush, status: "in_progress", conclusion: null }]],
    ["a pull_request run of the same commit", [{ ...greenPush, event: "pull_request" }]],
    ["a manual run", [{ ...greenPush, event: "workflow_dispatch" }]],
    ["a green run on another branch", [{ ...greenPush, head_branch: "feature" }]],
    ["a green run of another commit", [{ ...greenPush, head_sha: other }]],
  ])("refuses a candidate whose CI evidence is %s", async (_name, runs) => {
    await expect(verifyStagingCandidate(baseEnv, githubFetch({ ci: runs }))).rejects.toThrow(
      "No successful main push CI run",
    );
  });

  it("fails closed when GitHub can't be read, without echoing the token", async () => {
    const error = await verifyStagingCandidate(baseEnv, githubFetch({ ciStatus: 500 })).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 500");
    expect((error as Error).message).not.toContain("test-token");
  });

  it.each([
    ["a missing token", { RELEASE_GITHUB_TOKEN: "" }, "RELEASE_GITHUB_TOKEN is required"],
    ["a malformed repository", { RELEASE_REPOSITORY: "syveka" }, "RELEASE_REPOSITORY is invalid"],
  ])("refuses %s", async (_name, patch, message) => {
    const fetchMock = githubFetch();
    await expect(verifyStagingCandidate({ ...baseEnv, ...patch }, fetchMock)).rejects.toThrow(
      message,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the token only as a bearer header to the configured API origin", async () => {
    const fetchMock = githubFetch();
    await verifyStagingCandidate(baseEnv, fetchMock);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input).startsWith("https://api.github.test/repos/syveka/syveka-ai/")).toBe(
        true,
      );
      expect(String(input)).not.toContain("test-token");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    }
  });
});
