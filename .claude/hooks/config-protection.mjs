#!/usr/bin/env node
import path from "node:path";

// PreToolUse guardrail: gates Edit/Write access to security/quality-critical shared
// config so the agent can't silently weaken CI gates (CLAUDE.md §9 lists CI-policy
// and workflow-policy changes as requiring explicit authorization). Unlike
// block-no-verify, this one supports an explicit human override: a human who has
// consciously approved a specific config change can set
// SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1 in their own shell environment before
// launching the session. The agent cannot set this itself — Bash/PowerShell tool
// calls in this harness don't persist environment state into the hook's process.

const ALWAYS_PROTECTED = [
  /(^|\/)eslint\.config\.(mjs|js|cjs|ts)$/,
  /(^|\/)\.eslintrc(\..*)?$/,
  /(^|\/)\.prettierrc(\..*)?$/,
  /(^|\/)prettier\.config\.(mjs|js|cjs)$/,
  /^tsconfig(\.[\w-]+)?\.json$/,
  /(^|\/)\.github\/workflows\/.*\.ya?ml$/,
  /(^|\/)\.claude\/settings\.json$/,
  /(^|\/)\.claude\/hooks\/.*/,
  /^CLAUDE\.md$/,
  /(^|\/)scripts\/ci\/.*/,
  /(^|\/)scripts\/(check-i18n-parity|check-migration-history|verify-release-chain|validate-staging-config|verify-prisma-engine|generate-legacy-schema-contract|check-dashboard-index-ownership)\.(mjs|ts|js)$/,
];

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

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function toRelPosix(cwd, filePath) {
  const rel = path.relative(cwd || process.cwd(), filePath);
  return rel.split(path.sep).join("/");
}

function touchesCriticalScript(text) {
  return CRITICAL_SCRIPT_KEYS.some((key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`"${escaped}"\\s*:`).test(text);
  });
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = payload?.tool_name;
  if (toolName !== "Edit" && toolName !== "Write") {
    process.exit(0);
  }

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath === "") {
    process.exit(0);
  }

  const relPath = toRelPosix(payload?.cwd, filePath);

  let reason = null;
  if (ALWAYS_PROTECTED.some((pattern) => pattern.test(relPath))) {
    reason = `"${relPath}" is a protected verification-critical config file`;
  } else if (relPath === "package.json") {
    const text =
      toolName === "Edit"
        ? `${payload?.tool_input?.old_string ?? ""}\n${payload?.tool_input?.new_string ?? ""}`
        : (payload?.tool_input?.content ?? "");
    if (touchesCriticalScript(text)) {
      reason = `the edit touches a required validation script entry in package.json ("scripts")`;
    }
  }

  if (!reason) {
    process.exit(0);
  }

  if (process.env.SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT === "1") {
    process.stderr.write(
      `SYVEKA guardrail (config-protection): allowing edit — ${reason} — because ` +
        "SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1 is set in the environment.\n",
    );
    process.exit(0);
  }

  process.stderr.write(
    `Blocked by SYVEKA guardrail (config-protection): ${reason}. Per CLAUDE.md §9, changes to ` +
      "CI-policy/verification-critical config require explicit human authorization for this " +
      "specific change. If a human has approved this exact change, they should set " +
      "SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1 in their own shell before the session, or make the " +
      "edit directly.\n",
  );
  process.exit(2);
}

main();
