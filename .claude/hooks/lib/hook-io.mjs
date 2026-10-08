// Shared PreToolUse plumbing for the SYVEKA guardrail hooks.
//
// Decisions (Claude Code combines multiple hooks as deny > ask > allow):
//   deny  -> exit 2, reason on stderr. Not overridable by permission rules or modes.
//   ask   -> exit 0 with a PreToolUse `permissionDecision: "ask"` JSON. Forces a human
//            prompt even when an allow rule matches or auto mode is on; in headless
//            `claude -p` runs it is treated as a denial.
//   allow -> exit 0 with no output, so normal permission rules still apply.
//
// Fail-safe: Claude Code treats any exit code other than 2 (a crash, a missing file) and
// a hook that outlives its own timeout as non-blocking. So:
//   - the hooks are registered as `node ... || exit 2`, turning any crash or other non-2
//     exit into a deny;
//   - the inspection runs in a worker thread, and a 45 s deadline (well below the hook's
//     registered timeout) starts as soon as the hook starts, covering input reading too.
//     When it expires, or the inspection crashes, the hook writes its deny reason and
//     kills its own process: a worker blocked inside a native call (a slow file system or
//     child process) would otherwise delay a normal exit past the hook timeout. The kill
//     exits non-2, which `|| exit 2` turns into a deny. Only Node is needed, so this
//     behaves the same on Windows Git Bash, Linux and macOS;
//   - malformed input is denied;
//   - an error thrown by evaluate() denies only when the tool input looks
//     security-sensitive, so a guard bug can't lock out routine work.
// evaluate() must be synchronous.

import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

export const CHARTER_NOTE =
  "Per CLAUDE.md §9 this requires explicit human authorization for this specific instance.";

export const GUARD_TIMEOUT_MS = 45_000;

// Tests may shorten the deadline; it can never be raised above GUARD_TIMEOUT_MS.
function guardTimeoutMs() {
  const requested = Number(process.env.SYVEKA_GUARD_TIMEOUT_MS);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, GUARD_TIMEOUT_MS)
    : GUARD_TIMEOUT_MS;
}

function describeDuration(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 1000)} s`;
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function writeDenyReason(guard, reasons) {
  const unique = [...new Set(reasons)];
  writeSync(
    2,
    `Blocked by SYVEKA guardrail (${guard}): ${unique.join("; ")}. ${CHARTER_NOTE} ` +
      "The agent may not run this; if it is genuinely authorized, a human should run it " +
      "directly (for example with the `!` prefix in Claude Code).\n",
  );
}

export function deny(guard, reasons) {
  writeDenyReason(guard, reasons);
  process.exit(2);
}

// Deny without waiting for a possibly blocked worker: a native call in the worker would
// delay process.exit(). The forced kill exits non-2, which `|| exit 2` makes a deny.
function hardDeny(guard, reasons) {
  writeDenyReason(guard, reasons);
  process.kill(process.pid, "SIGKILL");
}

export function ask(guard, reasons) {
  const unique = [...new Set(reasons)];
  writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason:
          `SYVEKA guardrail (${guard}): ${unique.join("; ")}. ${CHARTER_NOTE} ` +
          "Approve only if you explicitly authorized this exact action.",
      },
    }),
  );
  process.exit(0);
}

export const SENSITIVE_FALLBACK =
  /no-ver|hookspath|husky|\bgit\b|\bcommit\b|\bpush\b|\breset\b|\bclean\b|checkout|restore|\bbranch\b|worktree|rebase|filter-|\bgh\b|vercel|supabase|prisma|psql|pg_|\.env|secret|token|password|credential|\.claude|claude\.md|staging|deploy|release|mcp__|environ|printenv|invoke-expression|\biex\b|-enc/i;

export function isSensitiveText(text) {
  return SENSITIVE_FALLBACK.test(String(text ?? ""));
}

// Test hooks that simulate a stalled inspection. They can only make the guard slower,
// which the deadline turns into a deny.
function simulateStallForTests() {
  const busyMs = Number(process.env.SYVEKA_GUARD_TEST_STALL_MS);
  if (Number.isFinite(busyMs) && busyMs > 0) {
    const until = Date.now() + busyMs;
    while (Date.now() < until) {
      // busy-wait: a JavaScript stall blocks the thread the same way
    }
  }
  const nativeMs = Number(process.env.SYVEKA_GUARD_TEST_NATIVE_STALL_MS);
  if (Number.isFinite(nativeMs) && nativeMs > 0) {
    // A blocking native call, like a file-system read on an unreachable share.
    spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${Math.round(nativeMs)})`]);
  }
}

// Worker side: parse and evaluate the payload, then report the verdict (or the error).
function evaluateInWorker(evaluate) {
  simulateStallForTests();
  try {
    const verdict = evaluate(JSON.parse(workerData.raw));
    // Guards must be synchronous: a Promise here would otherwise read as "no objection".
    if (verdict && typeof verdict.then === "function") {
      throw new Error("guard returned a Promise; evaluate must be synchronous");
    }
    parentPort.postMessage({ verdict: { deny: verdict?.deny ?? [], ask: verdict?.ask ?? [] } });
  } catch (error) {
    parentPort.postMessage({ error: String(error?.message ?? error ?? "unknown") });
  }
}

// Parent side: run the inspection in a worker. The caller owns the deadline.
function evaluateInWorkerThread(moduleUrl, raw) {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(new URL(moduleUrl), { workerData: { raw } });
    function finish(outcome) {
      if (settled) return;
      settled = true;
      resolve(outcome);
    }
    worker.once("message", (message) => finish(message));
    worker.once("error", () => finish({ crashed: "the inspection failed to run" }));
    // A verdict posted just before the worker exits is delivered first; give it a moment.
    worker.once("exit", (code) =>
      setTimeout(() => finish({ crashed: `the inspection exited early (code ${code})` }), 50),
    );
  });
}

async function runGuardMain(guard, moduleUrl) {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    deny(guard, ["could not read hook input"]);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    deny(guard, ["hook input was not valid JSON, so the call could not be inspected"]);
  }
  if (!payload || typeof payload !== "object") {
    deny(guard, ["hook input was empty or malformed, so the call could not be inspected"]);
  }

  const outcome = await evaluateInWorkerThread(moduleUrl, raw);
  if (outcome.crashed) {
    hardDeny(guard, [`the inspection stopped unexpectedly (${outcome.crashed})`]);
  }
  if (outcome.error !== undefined) {
    // Judge the tool input only: the payload's transcript_path always contains `.claude`.
    if (SENSITIVE_FALLBACK.test(JSON.stringify(payload.tool_input ?? payload) ?? "")) {
      deny(guard, [
        `the guard hit an internal error (${outcome.error}) while inspecting a security-sensitive call`,
      ]);
    }
    process.exit(0);
  }
  const verdict = outcome.verdict ?? { deny: [], ask: [] };
  if (verdict.deny.length) deny(guard, verdict.deny);
  if (verdict.ask.length) ask(guard, verdict.ask);
  process.exit(0);
}

/**
 * Runs a guard. `evaluate(payload)` returns { deny: string[], ask: string[] }.
 * `moduleUrl` is the guard module's own `import.meta.url`: the module is re-loaded in a
 * worker thread, where this same call evaluates the payload instead of reading stdin.
 */
export function runGuard(guard, evaluate, moduleUrl) {
  if (!isMainThread) {
    evaluateInWorker(evaluate);
    return;
  }
  // The deadline covers everything: reading input, starting the worker and inspecting.
  const deadlineMs = guardTimeoutMs();
  setTimeout(() => {
    hardDeny(guard, [
      `the inspection did not finish within ${describeDuration(deadlineMs)}, so the call could not be verified`,
    ]);
  }, deadlineMs);
  runGuardMain(guard, moduleUrl).catch(() => {
    hardDeny(guard, ["the guard failed unexpectedly, so the call could not be verified"]);
  });
}
