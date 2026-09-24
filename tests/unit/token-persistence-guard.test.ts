import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The token-persistence guard runs after every credentialed `vercel pull`
 * (production release, staging Preview, stable staging alias). It must fail
 * closed on any match and, to be diagnosable, report where the token was
 * found -- file path and dotenv KEY name only, never a value or line.
 * These tests execute the exact block embedded in the workflows.
 */
const read = (file: string) =>
  fs
    .readFileSync(path.join(__dirname, "../../.github/workflows", file), "utf8")
    .replace(/\r\n?/g, "\n");
const deploy = read("deploy.yml");
const staging = read("staging-release.yml");

const BEGIN = "          # >>> token-persistence guard";
const END = "          # <<< token-persistence guard\n";

function guardBlocks(workflow: string): { block: string; preceding: string }[] {
  const blocks: { block: string; preceding: string }[] = [];
  let from = 0;
  for (;;) {
    const start = workflow.indexOf(BEGIN, from);
    if (start < 0) return blocks;
    const end = workflow.indexOf(END, start) + END.length;
    const before = workflow.slice(0, start).trimEnd().split("\n");
    blocks.push({ block: workflow.slice(start, end), preceding: before.slice(-2).join("\n") });
    from = end;
  }
}

const deployBlocks = guardBlocks(deploy);
const stagingBlocks = guardBlocks(staging);
const guard = deployBlocks[0]!.block;

const TOKEN = "Tk9fakeVercelToken0123456789";

/** Runs the guard in a throwaway $HOME and working directory built by `setup`. */
function runGuard(setup: string, token = TOKEN) {
  const script = [
    "set -euo pipefail",
    // Token via stdin (exact bytes, newlines included) -- argv is not
    // newline-safe on every platform the suite runs on.
    'IFS= read -r -d "" guard_token || true',
    'work="$(mktemp -d)"',
    "trap 'rm -rf \"$work\"' EXIT",
    'export HOME="$work/home"',
    'mkdir -p "$HOME" "$work/repo"',
    'cd "$work/repo"',
    setup,
    guard,
    "echo GUARD_PASSED",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script, "guard-test"], {
    input: token,
    encoding: "utf8",
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { status: result.status, output };
}

function expectNoLeak(output: string) {
  expect(output).not.toContain(TOKEN);
  expect(output).not.toContain(TOKEN.slice(0, 12));
  expect(output).not.toContain(TOKEN.slice(-12));
  expect(output).not.toMatch(/prefix|suffix|"token"|SECRET_VALUE/);
  for (const line of output.split("\n")) expect(line.startsWith("::")).toBe(false);
}

describe("token-persistence guard: one implementation everywhere", () => {
  it("is the identical block after every credentialed `vercel pull`", () => {
    expect(deployBlocks).toHaveLength(1);
    expect(stagingBlocks).toHaveLength(2);
    for (const { block } of stagingBlocks) expect(block).toBe(guard);
    expect(deployBlocks[0]!.preceding).toContain('guard_token="$VERCEL_TOKEN"');
    for (const { preceding } of [...deployBlocks, ...stagingBlocks]) {
      expect(preceding).toMatch(/vercel@\$VERCEL_CLI_VERSION" pull --yes --environment=/);
    }
    for (const { preceding } of stagingBlocks) {
      expect(preceding).toContain('guard_token="$STAGING_VERCEL_TOKEN"');
    }
    for (const workflow of [deploy, staging]) {
      expect(workflow).not.toContain("grep -rqsF");
      expect(workflow).not.toContain("continue-on-error");
    }
  });

  it("never prints the token, a matched line, or file contents by construction", () => {
    expect(guard).not.toMatch(
      /grep\s+-[a-zA-Z]*[no][a-zA-Z]*\s|grep\s+(?:-[a-zA-Z]+\s+)*--color|\bcat\b|\bhead\b|\btail\b/,
    );
    expect(guard).not.toMatch(/echo[^\n]*\$guard_token|printf[^\n]*\$guard_token/);
    expect(guard).not.toMatch(/sha\d*sum|md5|base64|xxd|od -/);
    expect(guard).toContain('grep -qF -- "$guard_token"');
  });
});

describe("token-persistence guard: behaviour", () => {
  it("passes when the token is nowhere on disk", () => {
    const { status, output } = runGuard(
      [
        'mkdir -p .vercel "$HOME/.local/share/com.vercel.cli"',
        "printf 'SAFE_KEY=value\\nOTHER=\"x\"\\n' > .vercel/.env.production.local",
        'printf \'{"projectId":"prj_x"}\' > .vercel/project.json',
        'printf \'{"telemetry":{}}\' > "$HOME/.local/share/com.vercel.cli/config.json"',
      ].join("\n"),
    );
    expect(status).toBe(0);
    expect(output).toContain("GUARD_PASSED");
    expect(output).not.toContain("Token guard:");
  });

  it("fails and names the dotenv file and KEY names -- never the value or the line", () => {
    const { status, output } = runGuard(
      [
        "mkdir -p .vercel",
        `printf 'SAFE_KEY=1\\nLEAKY_KEY="prefix%ssuffix"\\n  export OTHER_KEY=%s\\n' "$guard_token" "$guard_token" > .vercel/.env.production.local`,
      ].join("\n"),
    );
    expect(status).toBe(1);
    expect(output).not.toContain("GUARD_PASSED");
    expect(output).toContain(
      "Token guard: token value found in .vercel (vercel pull output) file: .vercel/.env.production.local",
    );
    expect(output).toContain("Token guard:   in variable LEAKY_KEY");
    expect(output).toContain("Token guard:   in variable OTHER_KEY");
    expect(output).not.toContain("SAFE_KEY");
    expect(output).not.toContain("LEAKY_KEY=");
    expect(output).toContain("refusing to build");
    expectNoLeak(output);
  });

  it("fails and names a Vercel CLI config file without printing its contents", () => {
    const { status, output } = runGuard(
      [
        'mkdir -p .vercel "$HOME/.local/share/com.vercel.cli"',
        `printf '{"token":"%s"}' "$guard_token" > "$HOME/.local/share/com.vercel.cli/auth.json"`,
      ].join("\n"),
    );
    expect(status).toBe(1);
    expect(output).toMatch(
      /Token guard: token value found in Vercel CLI config file: \S*\/\.local\/share\/com\.vercel\.cli\/auth\.json\n/,
    );
    expect(output).not.toContain("in variable");
    expectNoLeak(output);
  });

  it("reports a match on a non KEY=VALUE dotenv line by line number only", () => {
    const { status, output } = runGuard(
      [
        "mkdir -p .vercel",
        `printf 'MULTI="first\\nprefix%ssuffix"\\n' "$guard_token" > .vercel/.env.production.local`,
      ].join("\n"),
    );
    expect(status).toBe(1);
    expect(output).toContain("Token guard:   on line 2 (not a KEY=VALUE line)");
    expect(output).not.toContain("MULTI");
    expectNoLeak(output);
  });

  it("handles spaces, the token itself, and control characters in file names safely", () => {
    const { status, output } = runGuard(
      [
        "mkdir -p .vercel",
        `printf 'SECRET_VALUE %s' "$guard_token" > ".vercel/my file $guard_token.txt"`,
        `printf 'SECRET_VALUE %s' "$guard_token" > ".vercel/x"$'\\n'"::error::injected.txt"`,
      ].join("\n"),
    );
    expect(status).toBe(1);
    expect(output).toContain("file: .vercel/my file [REDACTED].txt");
    expect(output).toContain("file: .vercel/x?::error::injected.txt");
    expect(output).toContain("(2 finding(s))");
    expectNoLeak(output);
  });

  it("fails closed on an empty or multi-line token instead of matching everything or nothing", () => {
    for (const token of ["", "abc\ndef", "abc\r"]) {
      const { status, output } = runGuard("mkdir -p .vercel", token);
      expect(status, JSON.stringify(token)).toBe(1);
      expect(output).toContain(
        "Token guard: the Vercel token is empty or multi-line; refusing to build.",
      );
      expect(output).not.toContain("GUARD_PASSED");
    }
  });

  it("fails closed on a file it cannot read", () => {
    const { status, output } = runGuard(
      [
        "mkdir -p .vercel",
        "printf 'x' > .vercel/locked.json",
        "chmod 000 .vercel/locked.json",
        // Root, or a filesystem without POSIX permissions, cannot make it unreadable.
        "if [ -r .vercel/locked.json ]; then echo SKIP_NO_PERMS; exit 0; fi",
        'trap \'chmod 600 "$work/repo/.vercel/locked.json" 2>/dev/null; rm -rf "$work"\' EXIT',
      ].join("\n"),
    );
    if (output.includes("SKIP_NO_PERMS")) return;
    expect(status).toBe(1);
    expect(output).toMatch(
      /Token guard: (could not read|\.vercel \(vercel pull output\) contains unreadable)/,
    );
    expect(output).not.toContain("GUARD_PASSED");
  });
});

describe("token-persistence guard: nothing builds or deploys after a match", () => {
  type Step = { name: string; text: string };
  const stepsOf = (workflow: string): Step[] =>
    workflow
      .split("\n      - name: ")
      .slice(1)
      .map((chunk) => ({ name: chunk.split("\n")[0]!.trim(), text: chunk }));
  const VERCEL_WRITE = /vercel@\$VERCEL_CLI_VERSION" (build|deploy|promote)\b/;

  it("gives every guarded pull step a hard exit and no build/deploy/promote step a run condition", () => {
    for (const workflow of [deploy, staging]) {
      const steps = stepsOf(workflow);
      for (const step of steps.filter((s) => s.text.includes(BEGIN))) {
        expect(step.text, step.name).toContain("set -euo pipefail");
        expect(step.text, step.name).not.toMatch(/\n        if:/);
      }
      for (const step of steps.filter((s) => VERCEL_WRITE.test(s.text))) {
        expect(step.text, step.name).not.toMatch(/\n        if:/);
      }
    }
  });

  it("only runs known non-deploying steps after a failure", () => {
    const conditional = [...stepsOf(deploy), ...stepsOf(staging)]
      .filter((s) => /\n        if: .*(always|failure)\(\)/.test(s.text))
      .map((s) => s.name);
    expect(conditional.sort()).toEqual(
      [
        "Print the rollback command",
        "Restore the E2E account password",
        "Upload Playwright traces on failure",
      ].sort(),
    );
  });
});
