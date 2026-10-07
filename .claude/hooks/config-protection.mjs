#!/usr/bin/env node
// PreToolUse guardrail for file tools (CLAUDE.md §9).
//
// Edit/Write/NotebookEdit (and MultiEdit, for older Claude Code versions) on protected
// configuration are denied: CLAUDE.md, everything under .claude/ (settings, hooks,
// skills), .env files, lint/format/TypeScript/Vitest/Playwright config, .github/, CI
// and release-verification scripts, vercel.json, the guardrail tests, user-level
// Claude Code settings, and package.json edits that touch required validation scripts.
// Shell writes to the same paths are handled by command-guard with the same rules.
//
// Read/Grep of secret env files and credential stores are always denied.
//
// A human who has approved a specific protected-config change can start the session
// with SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1 in their own shell. The agent can't set it:
// tool calls don't persist environment state into the hook process. The override never
// unlocks secret reads.

import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { runGuard } from "./lib/hook-io.mjs";
import {
  isOverrideEnabled,
  isSecretPath,
  protectedConfigLabel,
  resolveArgPath,
} from "./lib/protected-paths.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CRITICAL_SCRIPT_KEYS = [
  "format:check",
  "lint",
  "typecheck",
  "test",
  "i18n:check",
  "migrations:check",
  "build",
  "test:e2e",
];

function touchesCriticalScript(text) {
  return CRITICAL_SCRIPT_KEYS.some((key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`"${escaped}"\\s*:`).test(text);
  });
}

function criticalScripts(text) {
  const scripts = JSON.parse(text)?.scripts ?? {};
  return JSON.stringify(CRITICAL_SCRIPT_KEYS.map((key) => scripts[key] ?? null));
}

// Applies the edit to the current file and compares the required validation scripts, so
// an edit that only touches a script's value (not its key) is still caught.
function changesCriticalScripts(toolName, input, filePath) {
  let before;
  try {
    before = readFileSync(filePath, "utf8");
  } catch {
    before = "{}";
  }
  let after = before;
  if (toolName === "Write") after = String(input?.content ?? "");
  else {
    const edits = toolName === "MultiEdit" ? (input?.edits ?? []) : [input];
    for (const edit of edits) {
      const oldString = String(edit?.old_string ?? "");
      const newString = String(edit?.new_string ?? "");
      after = edit?.replace_all
        ? after.split(oldString).join(newString)
        : after.replace(oldString, newString);
    }
  }
  try {
    return criticalScripts(before) !== criticalScripts(after);
  } catch {
    // Unparseable result: fall back to flagging edits that mention a required script key.
    return touchesCriticalScript(editedText(toolName, input));
  }
}

function editedText(toolName, input) {
  if (toolName === "Write") return String(input?.content ?? "");
  if (toolName === "MultiEdit") {
    return (input?.edits ?? [])
      .map((e) => `${e?.old_string ?? ""}\n${e?.new_string ?? ""}`)
      .join("\n");
  }
  return `${input?.old_string ?? ""}\n${input?.new_string ?? ""}`;
}

runGuard("config-protection", (payload) => {
  const verdict = { deny: [], ask: [] };
  const toolName = String(payload.tool_name ?? "");
  const input = payload.tool_input ?? {};
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const roots = [process.env.CLAUDE_PROJECT_DIR || cwd, cwd];

  if (toolName === "Read" || toolName === "Grep") {
    for (const candidate of [input.file_path, input.path, input.glob]) {
      if (typeof candidate !== "string" || !candidate) continue;
      if (isSecretPath(resolveArgPath(candidate, cwd))) {
        verdict.deny.push(
          `"${candidate}" is a secret or credential file and must not be read by the agent`,
        );
      }
    }
    return verdict;
  }
  if (!EDIT_TOOLS.has(toolName)) return verdict;

  const filePath = input.file_path ?? input.notebook_path;
  if (filePath !== undefined && typeof filePath !== "string") {
    verdict.deny.push("the edit target path is malformed, so the call could not be inspected");
    return verdict;
  }
  if (!filePath) return verdict;
  const abs = resolveArgPath(filePath, cwd);

  let reason = null;
  const label = protectedConfigLabel(abs, roots);
  if (label) {
    reason = `"${label}" is a protected verification-critical config file`;
  } else if (
    /(^|\/)package\.json$/.test(abs) &&
    changesCriticalScripts(toolName, input, path.resolve(cwd, filePath))
  ) {
    reason = `the edit touches a required validation script entry in package.json ("scripts")`;
  }
  if (!reason) return verdict;

  if (isOverrideEnabled()) {
    writeSync(
      2,
      `SYVEKA guardrail (config-protection): allowing edit — ${reason} — because ` +
        "SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1 is set in the environment.\n",
    );
    return verdict;
  }
  verdict.deny.push(
    `${reason}. If a human has approved this exact change, they should set ` +
      "SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1 in their own shell before the session, or make the edit directly",
  );
  return verdict;
});
