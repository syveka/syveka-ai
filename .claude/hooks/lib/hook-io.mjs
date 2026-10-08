// Shared PreToolUse plumbing for the SYVEKA guardrail hooks.
//
// Decisions (Claude Code combines multiple hooks as deny > ask > allow):
//   deny  -> exit 2, reason on stderr. Not overridable by permission rules or modes.
//   ask   -> exit 0 with a PreToolUse `permissionDecision: "ask"` JSON. Forces a human
//            prompt even when an allow rule matches or auto mode is on; in headless
//            `claude -p` runs it is treated as a denial.
//   allow -> exit 0 with no output, so normal permission rules still apply.
//
// Fail-safe: Claude Code treats any exit code other than 2 (a crash, a missing file)
// as non-blocking, so the hooks are registered as `node ... || exit 2` and never
// exit 1 on purpose: any crash outside evaluate() (import or syntax error, missing
// file) is turned into a deny by that wrapper. Malformed input is denied. An error
// thrown by evaluate() denies only when the raw input looks security-sensitive, so a
// guard bug can't lock out routine work; on other input it is allowed silently.
// evaluate() must be synchronous.

import { writeSync } from "node:fs";

export const CHARTER_NOTE =
  "Per CLAUDE.md §9 this requires explicit human authorization for this specific instance.";

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function deny(guard, reasons) {
  const unique = [...new Set(reasons)];
  writeSync(
    2,
    `Blocked by SYVEKA guardrail (${guard}): ${unique.join("; ")}. ${CHARTER_NOTE} ` +
      "The agent may not run this; if it is genuinely authorized, a human should run it " +
      "directly (for example with the `!` prefix in Claude Code).\n",
  );
  process.exit(2);
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

/**
 * Runs a guard. `evaluate(payload)` returns { deny: string[], ask: string[] }.
 */
export async function runGuard(guard, evaluate) {
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
  let verdict;
  try {
    verdict = evaluate(payload);
    // Guards must be synchronous: a Promise here would otherwise read as "no objection".
    if (verdict && typeof verdict.then === "function") {
      throw new Error("guard returned a Promise; evaluate must be synchronous");
    }
  } catch (error) {
    // Judge the tool input only: the payload's transcript_path always contains `.claude`.
    if (SENSITIVE_FALLBACK.test(JSON.stringify(payload.tool_input ?? payload) ?? "")) {
      deny(guard, [
        `the guard hit an internal error (${error?.message ?? "unknown"}) while inspecting a security-sensitive call`,
      ]);
    }
    process.exit(0);
  }
  if (verdict?.deny?.length) deny(guard, verdict.deny);
  if (verdict?.ask?.length) ask(guard, verdict.ask);
  process.exit(0);
}
