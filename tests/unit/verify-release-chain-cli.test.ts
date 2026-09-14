import { execFile } from "node:child_process";
import http, { type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// Runs the script exactly the way production does: `tsx scripts/verify-release-chain.ts`
// (see .github/workflows/deploy.yml). This file has no "type": "module" ancestor in
// package.json, so tsx/esbuild transforms it as CommonJS -- a bare top-level `await` at
// the bottom of the file used to fail esbuild's CJS output entirely
// ("Top-level await is currently not supported with the 'cjs' output format"), which is a
// transform-time error unrelated to any release-chain logic. Only a real child-process
// run through the actual tsx CLI can catch a regression back to that shape; a Vitest
// import of the module (as in release-chain.test.ts) would never hit the CLI transform.
const TSX_CLI = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/verify-release-chain.ts");
const sha = "a".repeat(40);

// Must run the child process asynchronously (not execFileSync): tests that also host a
// mock GitHub API server in this same process need the event loop free to service the
// child's HTTP requests while we wait for it to exit -- a synchronous, blocking wait here
// would deadlock the child against its own server.
async function runCli(
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX_CLI, SCRIPT_PATH], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code: number | null; stdout?: string; stderr?: string };
    return { status: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function withMockGitHubApi<T>(
  handler: (req: http.IncomingMessage) => { status: number; body: unknown },
  run: (apiUrl: string) => Promise<T>,
): Promise<T> {
  const server: Server = http.createServer((req, res) => {
    const { status, body } = handler(req);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    // Without this, undici's keep-alive socket stays open after the response,
    // which keeps the child tsx process's event loop alive.
    res.setHeader("connection", "close");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to bind mock GitHub API server.");
    }
    // Awaited here (not returned directly) so the `finally` below can't close the
    // server -- and its listening event loop -- before the child process is done
    // using it.
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function successHandler(req: http.IncomingMessage): { status: number; body: unknown } {
  const url = req.url ?? "";
  if (url.includes("/git/ref/heads/main")) {
    return { status: 200, body: { object: { sha } } };
  }
  if (url.includes("/workflows/ci.yml/")) {
    return {
      status: 200,
      body: {
        workflow_runs: [
          {
            head_sha: sha,
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    };
  }
  if (url.includes("/workflows/staging-release.yml/")) {
    return {
      status: 200,
      body: {
        workflow_runs: [
          {
            head_sha: sha,
            head_branch: "main",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    };
  }
  return { status: 404, body: {} };
}

describe("scripts/verify-release-chain.ts CLI entrypoint", () => {
  it("transforms and runs under the real tsx CLI without a CommonJS top-level-await error", async () => {
    // Deliberately invalid input so the script fails fast on validation, before any
    // network call -- this isolates the transform/startup step from verification logic.
    const result = await runCli({ ...process.env, CANDIDATE_SHA: "" });
    expect(result.stderr).not.toContain("Top-level await is currently not supported");
    expect(result.stderr).not.toContain("Transform failed");
    expect(result.stderr).not.toContain("TransformError");
  });

  it("exits non-zero and reports the reason when release-chain verification fails", async () => {
    const result = await runCli({ ...process.env, CANDIDATE_SHA: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "CANDIDATE_SHA must be an exact lowercase 40-character Git SHA",
    );
  });

  it("exits 0 once the release chain verifies successfully end to end", async () => {
    const result = await withMockGitHubApi(successHandler, (apiUrl) =>
      runCli({
        ...process.env,
        CANDIDATE_SHA: sha,
        CONFIRM_PRODUCTION_SHA: sha,
        RELEASE_REPOSITORY: "syveka/syveka-ai",
        RELEASE_GITHUB_TOKEN: "test-token",
        RELEASE_API_URL: apiUrl,
        RELEASE_MAIN_BRANCH: "main",
        RELEASE_CI_WORKFLOW: "ci.yml",
        RELEASE_STAGING_WORKFLOW: "staging-release.yml",
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Release chain verified for ${sha}.`);
  });

  it("exits non-zero when the release chain is missing required evidence", async () => {
    const result = await withMockGitHubApi(
      (req) => {
        const url = req.url ?? "";
        if (url.includes("/git/ref/heads/main")) {
          return { status: 200, body: { object: { sha } } };
        }
        // No successful CI/staging runs for the candidate SHA.
        return { status: 200, body: { workflow_runs: [] } };
      },
      (apiUrl) =>
        runCli({
          ...process.env,
          CANDIDATE_SHA: sha,
          CONFIRM_PRODUCTION_SHA: sha,
          RELEASE_REPOSITORY: "syveka/syveka-ai",
          RELEASE_GITHUB_TOKEN: "test-token",
          RELEASE_API_URL: apiUrl,
          RELEASE_MAIN_BRANCH: "main",
          RELEASE_CI_WORKFLOW: "ci.yml",
          RELEASE_STAGING_WORKFLOW: "staging-release.yml",
        }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No successful main push CI run exists for CANDIDATE_SHA");
  });
});
