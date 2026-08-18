import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Provider } from "../types.js";
import type { ProviderResult } from "../../schemas/index.js";

const execFileAsync = promisify(execFile);

/** Captures a real `git diff` as diff-type evidence for a given working directory. */
export function createGitDiffProvider(params: { cwd: string }): Provider {
  return {
    id: "git-diff",
    isAvailable: () => true,
    async execute(): Promise<ProviderResult> {
      try {
        const { stdout } = await execFileAsync("git", ["diff", "--stat"], { cwd: params.cwd });
        const { stdout: fullDiff } = await execFileAsync("git", ["diff"], { cwd: params.cwd });
        return {
          status: "SUCCESS",
          message: "captured working tree diff",
          evidence: [
            {
              type: "diff",
              description: "git diff --stat",
              data: stdout.slice(0, 2000),
              timestamp: new Date().toISOString(),
            },
            {
              type: "diff",
              description: "git diff (full)",
              data: fullDiff.slice(0, 4000),
              timestamp: new Date().toISOString(),
            },
          ],
        };
      } catch (err) {
        return {
          status: "FAILURE",
          message: `git diff failed: ${(err as Error).message}`,
          evidence: [],
        };
      }
    },
  };
}
