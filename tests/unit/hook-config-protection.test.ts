import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
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
