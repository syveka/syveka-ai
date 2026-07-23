import { describe, expect, it, vi } from "vitest";

import {
  verifyReleaseCandidate,
  type ReleaseEnvironment,
} from "../../scripts/verify-release-chain";

const sha = "a".repeat(40);
const baseEnv: ReleaseEnvironment = {
  CANDIDATE_SHA: sha,
  CONFIRM_PRODUCTION_SHA: sha,
  RELEASE_REPOSITORY: "syveka/syveka-ai",
  RELEASE_GITHUB_TOKEN: "test-token",
  RELEASE_API_URL: "https://api.github.test",
  RELEASE_MAIN_BRANCH: "main",
  RELEASE_CI_WORKFLOW: "ci.yml",
  RELEASE_STAGING_WORKFLOW: "staging-release.yml",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulFetch(overrides?: { mainSha?: string; ci?: unknown[]; staging?: unknown[] }) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/git/ref/heads/main")) {
      return response({ object: { sha: overrides?.mainSha ?? sha } });
    }
    if (url.includes("/workflows/ci.yml/")) {
      return response({
        workflow_runs: overrides?.ci ?? [
          {
            head_sha: sha,
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    }
    if (url.includes("/workflows/staging-release.yml/")) {
      return response({
        workflow_runs: overrides?.staging ?? [
          {
            head_sha: sha,
            head_branch: "main",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    }
    return response({}, 404);
  });
}

describe("production release chain", () => {
  it("accepts only an exact current main SHA with successful CI and staging runs", async () => {
    const fetchMock = successfulFetch();
    await expect(verifyReleaseCandidate(baseEnv, fetchMock)).resolves.toBe(sha);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed or mismatched confirmation SHAs before querying GitHub", async () => {
    const fetchMock = successfulFetch();
    await expect(
      verifyReleaseCandidate({ ...baseEnv, CANDIDATE_SHA: "main" }, fetchMock),
    ).rejects.toThrow("exact lowercase 40-character Git SHA");
    await expect(
      verifyReleaseCandidate({ ...baseEnv, CONFIRM_PRODUCTION_SHA: "b".repeat(40) }, fetchMock),
    ).rejects.toThrow("exactly match");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a candidate that is no longer the main branch tip", async () => {
    await expect(
      verifyReleaseCandidate(baseEnv, successfulFetch({ mainSha: "b".repeat(40) })),
    ).rejects.toThrow("not the current immutable main SHA");
  });

  it("rejects missing CI or staging evidence for the exact SHA", async () => {
    await expect(verifyReleaseCandidate(baseEnv, successfulFetch({ ci: [] }))).rejects.toThrow(
      "No successful main push CI run",
    );
    await expect(verifyReleaseCandidate(baseEnv, successfulFetch({ staging: [] }))).rejects.toThrow(
      "No successful staging release validation",
    );
  });

  it("does not accept successful checks from a different event or branch", async () => {
    const wrongRun = [
      {
        head_sha: sha,
        head_branch: "feature/not-main",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
      },
    ];
    await expect(
      verifyReleaseCandidate(baseEnv, successfulFetch({ staging: wrongRun })),
    ).rejects.toThrow("No successful staging release validation");
  });
});
