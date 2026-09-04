import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude", "hooks", "block-no-verify.mjs");

function runHook(command: string) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: REPO_ROOT }),
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

describe("block-no-verify guardrail", () => {
  it("blocks git commit --no-verify", () => {
    const { status, stderr } = runHook('git commit --no-verify -m "msg"');
    expect(status).toBe(2);
    expect(stderr).toContain("bypasses git verification hooks");
  });

  it("blocks git commit -n (short form)", () => {
    const { status } = runHook('git commit -n -m "msg"');
    expect(status).toBe(2);
  });

  it("blocks git push --no-verify", () => {
    const { status } = runHook("git push --no-verify origin main");
    expect(status).toBe(2);
  });

  it("blocks a -c core.hooksPath= override before the subcommand", () => {
    const { status, stderr } = runHook('git -c core.hooksPath=/dev/null commit -m "msg"');
    expect(status).toBe(2);
    expect(stderr).toContain("core.hooksPath");
  });

  it("blocks --no-verify chained after other commands", () => {
    const { status } = runHook('git add -A && git commit --no-verify -m "msg"');
    expect(status).toBe(2);
  });

  it("blocks the flag regardless of position in the command", () => {
    const { status } = runHook('git commit -m "msg" --no-verify');
    expect(status).toBe(2);
  });

  it("allows a normal commit", () => {
    const { status } = runHook('git commit -m "msg"');
    expect(status).toBe(0);
  });

  it("allows a normal push", () => {
    const { status } = runHook("git push origin main");
    expect(status).toBe(0);
  });

  it("does not false-positive on a quoted commit message mentioning --no-verify", () => {
    const { status } = runHook('git commit -m "fix: remove --no-verify workaround from CI script"');
    expect(status).toBe(0);
  });

  it("does not false-positive on a heredoc commit message mentioning no-verify", () => {
    const command = [
      "git commit -m \"$(cat <<'EOF'",
      "Fix: stop bypassing --no-verify in scripts",
      "",
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
      "EOF",
      ')"',
    ].join("\n");
    const { status } = runHook(command);
    expect(status).toBe(0);
  });

  it("does not false-positive on git push -n (dry-run, not no-verify)", () => {
    const { status } = runHook("git push -n origin main");
    expect(status).toBe(0);
  });

  it("allows unrelated commands", () => {
    const { status } = runHook("npm run build");
    expect(status).toBe(0);
  });

  it("allows plain read-only git commands", () => {
    const { status } = runHook("git log --oneline -5");
    expect(status).toBe(0);
  });

  it("blocks a command-substitution wrapper glued to a variable assignment", () => {
    const { status } = runHook('RESULT=$(git commit --no-verify -m "x")');
    expect(status).toBe(2);
  });

  it("blocks a bare command-substitution wrapper", () => {
    const { status } = runHook('$(git commit -n -m "x")');
    expect(status).toBe(2);
  });

  it("blocks a parenthesized subshell wrapper", () => {
    const { status } = runHook('(git commit -n -m "x")');
    expect(status).toBe(2);
  });

  it("does not false-positive on an unrelated assignment containing a substitution", () => {
    const { status } = runHook('git commit -m "note: X=$(compute) is fine"');
    expect(status).toBe(0);
  });
});
