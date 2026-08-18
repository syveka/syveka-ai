/**
 * DEMO 2 - Bug fix.
 *
 * "Fix this failing workflow." Expected orchestration per the product
 * brief: inspect -> reproduce -> diagnose -> fix -> regression test ->
 * verify -> evidence report.
 *
 * This demo is fully real, not scripted-to-look-real: it runs an actual
 * failing Node test (RED), applies an actual code fix to a throwaway git
 * repo, runs the actual orchestrator (which re-runs the real test and
 * captures a real git diff), and prints the genuine verification result.
 * The one deliberately-scripted part is the fix itself (writing correct
 * code is the host LLM agent's job, not this orchestrator's - see
 * core/intent/index.ts's module doc comment) - everything downstream of
 * that (test execution, diff capture, evidence, verification, report) is
 * the orchestrator doing real work against real command output.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTask } from "../../core/orchestrator.js";
import { renderReportMarkdown } from "../../core/reporting/index.js";
import { createLocalTestRunnerProvider } from "../../providers/local-test-runner/index.js";
import { createGitDiffProvider } from "../../providers/git-diff/index.js";
import { ApprovalGate } from "../../core/approvals/index.js";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), "syveka-demo-bugfix-"));
  await cp(path.join(HERE, "fixture"), scratch, { recursive: true });

  await execFileAsync("git", ["init", "-q"], { cwd: scratch });
  await execFileAsync("git", ["config", "user.email", "demo@syveka.local"], { cwd: scratch });
  await execFileAsync("git", ["config", "user.name", "Syveka Demo"], { cwd: scratch });
  await execFileAsync("git", ["add", "-A"], { cwd: scratch });
  await execFileAsync("git", ["commit", "-q", "-m", "broken: add() subtracts instead of adding"], {
    cwd: scratch,
  });

  console.log("=== STEP 1: confirm RED (bug is real) ===");
  const preFixResult = await execFileAsync("node", ["--test", "add.test.mjs"], {
    cwd: scratch,
  }).catch((e: { stdout?: string; stderr?: string }) => e);
  const preFixOutput =
    ((preFixResult as { stdout?: string }).stdout ?? "") +
    ((preFixResult as { stderr?: string }).stderr ?? "");
  const preFixFailed = /fail 1/.test(preFixOutput);
  console.log(
    preFixFailed
      ? "CONFIRMED: test fails before any fix (bug is real)."
      : "UNEXPECTED: test did not fail before the fix.",
  );

  console.log("\n=== STEP 2: apply the fix ===");
  await writeFile(
    path.join(scratch, "add.mjs"),
    "export function add(a, b) {\n  return a + b;\n}\n",
  );
  console.log("Fix applied: add.mjs now returns a + b instead of a - b.");

  console.log("\n=== STEP 3: run the orchestrator (real test + real diff + real verification) ===");
  const providerMap = {
    "local-test-runner": createLocalTestRunnerProvider({
      command: "node",
      args: ["--test", "add.test.mjs"],
      cwd: scratch,
    }),
    "git-diff": createGitDiffProvider({ cwd: scratch }),
  };

  const report = await runTask("demo-bug-fix-1", "Fix this failing workflow", {
    providerMap,
    approvalGate: new ApprovalGate(),
    actionForCapability: () => "test.run.local", // LOW risk - no approval needed for local test/diff
  });

  console.log(renderReportMarkdown(report));

  if (!preFixFailed) {
    console.error("\nDEMO INTEGRITY CHECK FAILED: the RED step did not actually fail.");
    process.exitCode = 1;
  } else if (report.status !== "COMPLETE") {
    console.error(`\nDEMO DID NOT REACH COMPLETE (got ${report.status}) - see report above.`);
    process.exitCode = 1;
  } else {
    console.log("\nDemo result: COMPLETE, verified with real test + diff evidence.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
