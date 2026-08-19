import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Provider } from "../types.js";
import type { ProviderResult } from "../../schemas/index.js";

const execFileAsync = promisify(execFile);

/**
 * Runs a real command (a test file, a build step, etc.) via a fixed
 * command + argv array - never a shell string - so caller-supplied input
 * can never be interpreted as shell syntax. Genuinely executes; this is
 * not a mock. See docs/provider-model.md for why this is the reference
 * "real" provider the MVP demos are built around.
 */
export function createLocalTestRunnerProvider(params: {
  command: string;
  args: string[];
  cwd: string;
}): Provider {
  return {
    id: "local-test-runner",
    isAvailable: () => true,
    async execute(): Promise<ProviderResult> {
      try {
        const { stdout, stderr } = await execFileAsync(params.command, params.args, {
          cwd: params.cwd,
          timeout: 60_000,
        });
        return {
          status: "SUCCESS",
          message: `command exited 0: ${params.command} ${params.args.join(" ")}`,
          evidence: [
            {
              type: "test",
              description: `${params.command} ${params.args.join(" ")} (exit 0)`,
              data: (stdout + stderr).slice(0, 4000),
              timestamp: new Date().toISOString(),
            },
          ],
        };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        return {
          status: "FAILURE",
          message: `command failed: ${params.command} ${params.args.join(" ")}`,
          evidence: [
            {
              type: "test",
              description: `${params.command} ${params.args.join(" ")} (non-zero exit)`,
              data: ((e.stdout ?? "") + (e.stderr ?? "") + e.message).slice(0, 4000),
              timestamp: new Date().toISOString(),
            },
          ],
        };
      }
    },
  };
}
