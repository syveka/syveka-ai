import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude", "hooks", "config-protection.mjs");

function runHook(payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ cwd: REPO_ROOT, ...payload }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stderr: result.stderr };
}

function editOf(relPath: string, oldString = "old", newString = "new") {
  return {
    tool_name: "Edit",
    tool_input: {
      file_path: path.join(REPO_ROOT, relPath),
      old_string: oldString,
      new_string: newString,
    },
  };
}

describe("config-protection guardrail", () => {
  it("blocks editing eslint.config.mjs", () => {
    const { status, stderr } = runHook(editOf("eslint.config.mjs"));
    expect(status).toBe(2);
    expect(stderr).toContain("protected verification-critical config file");
  });

  it("blocks editing the root .prettierrc", () => {
    const { status } = runHook(editOf(".prettierrc"));
    expect(status).toBe(2);
  });

  it("blocks editing tsconfig.json", () => {
    const { status } = runHook(editOf("tsconfig.json"));
    expect(status).toBe(2);
  });

  it("blocks editing a CI workflow file", () => {
    const { status } = runHook(editOf(".github/workflows/ci.yml"));
    expect(status).toBe(2);
  });

  it("blocks editing .claude/settings.json", () => {
    const { status } = runHook(editOf(".claude/settings.json"));
    expect(status).toBe(2);
  });

  it("blocks editing its own guardrail hook files", () => {
    const { status } = runHook(editOf(".claude/hooks/block-no-verify.mjs"));
    expect(status).toBe(2);
  });

  it("blocks editing CLAUDE.md", () => {
    const { status } = runHook(editOf("CLAUDE.md"));
    expect(status).toBe(2);
  });

  it("blocks editing the RLS CI check script", () => {
    const { status } = runHook(editOf("scripts/ci/run-rls-check.sh"));
    expect(status).toBe(2);
  });

  it("blocks editing package.json when the diff touches a critical script key", () => {
    const { status, stderr } = runHook(
      editOf("package.json", '"lint": "eslint ."', '"lint": "echo skip"'),
    );
    expect(status).toBe(2);
    expect(stderr).toContain("scripts");
  });

  it("allows editing package.json when only a dependency version changes", () => {
    const { status } = runHook(editOf("package.json", '"zod": "^3.24.2"', '"zod": "^3.25.0"'));
    expect(status).toBe(0);
  });

  it("allows editing a normal source file", () => {
    const { status } = runHook(editOf("src/app/layout.tsx"));
    expect(status).toBe(0);
  });

  it("allows editing README-style docs", () => {
    const { status } = runHook(editOf("docs/ARCHITECTURE.md"));
    expect(status).toBe(0);
  });

  it("allows a Write to a normal source file", () => {
    const { status } = runHook({
      tool_name: "Write",
      tool_input: {
        file_path: path.join(REPO_ROOT, "src/app/page.tsx"),
        content: "export default function Page(){}",
      },
    });
    expect(status).toBe(0);
  });

  it("blocks a Write that overwrites a protected config file", () => {
    const { status } = runHook({
      tool_name: "Write",
      tool_input: {
        file_path: path.join(REPO_ROOT, "eslint.config.mjs"),
        content: "export default []",
      },
    });
    expect(status).toBe(2);
  });

  it("allows a normally-protected edit when SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1 is set", () => {
    const { status, stderr } = runHook(editOf("eslint.config.mjs"), {
      SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT: "1",
    });
    expect(status).toBe(0);
    expect(stderr).toContain("allowing edit");
  });

  it("ignores non-Edit/Write tool calls", () => {
    const { status } = runHook({
      tool_name: "Bash",
      tool_input: { command: "cat eslint.config.mjs" },
    });
    expect(status).toBe(0);
  });
});

describe("config-protection: consolidated coverage", () => {
  const statusOf = (payload: Record<string, unknown>, env: Record<string, string> = {}) =>
    runHook(payload, {
      CLAUDE_PROJECT_DIR: REPO_ROOT,
      SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT: "",
      ...env,
    }).status;

  it("blocks every file-editing tool on protected config", () => {
    const target = path.join(REPO_ROOT, ".claude", "settings.json");
    expect(statusOf({ tool_name: "Write", tool_input: { file_path: target, content: "{}" } })).toBe(
      2,
    );
    expect(
      statusOf({
        tool_name: "MultiEdit",
        tool_input: { file_path: target, edits: [{ old_string: "a", new_string: "b" }] },
      }),
    ).toBe(2);
    expect(
      statusOf({
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: path.join(REPO_ROOT, ".claude", "x.ipynb"), new_source: "x" },
      }),
    ).toBe(2);
  });

  it.each([
    "claude.md",
    "docs/CLAUDE.md",
    ".claude/settings.local.json",
    ".claude/skills/verify/SKILL.md",
    ".claude/hooks/lib/shell-parse.mjs",
    ".claude/agents/reviewer.md",
    ".env",
    ".env.local",
    ".env.production.local",
    "vitest.config.ts",
    "playwright.config.ts",
    ".github/CODEOWNERS",
    "vercel.json",
    "scripts/run-npm-audit.ts",
    "tests/unit/hook-command-guard.test.ts",
    ".claude/worktrees/other/CLAUDE.md",
    ".worktrees/other/.claude/settings.json",
  ])("blocks editing %s", (relPath) => {
    expect(statusOf(editOf(relPath))).toBe(2);
  });

  it.each([
    ".env.example",
    ".env.local.example",
    ".claude/worktrees/other/src/app/page.tsx",
    "src/lib/env.ts",
  ])("allows editing %s", (relPath) => {
    expect(statusOf(editOf(relPath))).toBe(0);
  });

  it("blocks editing user-level Claude Code settings outside the repository", () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "/home/user";
    expect(
      statusOf(editOf(path.relative(REPO_ROOT, path.join(home, ".claude", "settings.json")))),
    ).toBe(2);
  });

  it("denies Read and Grep of secret files even with the override", () => {
    const env = { SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT: "1" };
    expect(
      statusOf(
        { tool_name: "Read", tool_input: { file_path: path.join(REPO_ROOT, ".env.local") } },
        env,
      ),
    ).toBe(2);
    expect(statusOf({ tool_name: "Grep", tool_input: { pattern: "KEY", path: ".env" } }, env)).toBe(
      2,
    );
    expect(
      statusOf({ tool_name: "Grep", tool_input: { pattern: "KEY", glob: ".env*" } }, env),
    ).toBe(2);
    expect(
      statusOf({
        tool_name: "Read",
        tool_input: { file_path: path.join(REPO_ROOT, ".env.example") },
      }),
    ).toBe(0);
    expect(
      statusOf({ tool_name: "Read", tool_input: { file_path: path.join(REPO_ROOT, "CLAUDE.md") } }),
    ).toBe(0);
    expect(statusOf({ tool_name: "Grep", tool_input: { pattern: "x", path: "src" } })).toBe(0);
  });
});

describe("config-protection: second independent review (round 2)", () => {
  const statusOf = (payload: Record<string, unknown>) =>
    runHook(payload, { CLAUDE_PROJECT_DIR: REPO_ROOT, SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT: "" })
      .status;

  it.each([".git/config", ".git/hooks/pre-push", ".git/info/attributes", ".mcp.json"])(
    "blocks editing %s",
    (relPath) => {
      expect(statusOf(editOf(relPath))).toBe(2);
    },
  );

  it("denies a Grep glob that selects a secret file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-grep-"));
    fs.writeFileSync(path.join(dir, ".env.local"), "SECRET=1\n");
    try {
      for (const glob of ["*.local", ".e*", "{.env.local,x}"]) {
        expect(
          statusOf({ tool_name: "Grep", cwd: dir, tool_input: { pattern: "x", path: dir, glob } }),
        ).toBe(2);
      }
      expect(
        statusOf({
          tool_name: "Grep",
          cwd: dir,
          tool_input: { pattern: "x", path: dir, glob: "*.ts" },
        }),
      ).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
