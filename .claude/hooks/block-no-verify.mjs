#!/usr/bin/env node
// PreToolUse guardrail: stops the agent from bypassing git verification hooks
// (CLAUDE.md §9 "Never skip hooks (--no-verify)... unless the user has explicitly
// asked for it"). This is an unconditional block with no override flag on purpose:
// the safe path for a genuinely-approved bypass is for a human to type the git
// command themselves in their own terminal, not have the agent do it on the
// strength of text in a prompt (which could be spoofed via prompt injection).

const BYPASS_SUBCOMMANDS = new Set(["commit", "push", "am", "merge", "cherry-pick"]);
const VALUE_TAKING_GLOBAL_FLAGS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"]);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function ungluedAssignments(command) {
  // `VAR=$(...)` / `VAR=`...`` have no whitespace before the substitution,
  // so a plain whitespace split leaves "git" stuck to "VAR=$(" as one token.
  return command.replace(/=(\$\(|`)/g, "= $1");
}

function stripHeredocs(command) {
  return command.replace(
    /<<-?~?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?\n\2\b/g,
    "<<HEREDOC>>",
  );
}

function stripQuoted(command) {
  return command.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function findHooksPathBypass(segment) {
  return /(-c\s*core\.hooksPath\s*=|--config=?\s*core\.hooksPath\s*=)/i.test(segment);
}

function normalizeToken(token) {
  // Strips wrapping punctuation from constructs like `$(git ...)`, `(git ...)`,
  // or `` `git ...` `` so a command-substitution wrapper can't hide the flags
  // from exact-match comparison below.
  return token.replace(/^[$(`]+/, "").replace(/[)`]+$/, "");
}

function findNoVerifyBypass(segment) {
  if (!/\bgit\b/.test(segment)) return null;

  const tokens = segment.split(/\s+/).filter(Boolean).map(normalizeToken);
  const gitIdx = tokens.indexOf("git");
  if (gitIdx === -1) return null;

  let subcommand = null;
  let subcommandIdx = -1;
  for (let i = gitIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (VALUE_TAKING_GLOBAL_FLAGS.has(tok)) {
      i++; // skip this flag's value
      continue;
    }
    if (tok.startsWith("-")) continue;
    subcommand = tok;
    subcommandIdx = i;
    break;
  }
  if (!subcommand || !BYPASS_SUBCOMMANDS.has(subcommand)) return null;

  const rest = tokens.slice(subcommandIdx + 1);
  const hasNoVerify = rest.includes("--no-verify");
  const hasShortN = subcommand === "commit" && rest.includes("-n");
  if (hasNoVerify || hasShortN) {
    return `git ${subcommand} ${hasNoVerify ? "--no-verify" : "-n"}`;
  }
  return null;
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // fail open on unparsable input — nothing to analyze
  }

  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") {
    process.exit(0);
  }

  const sanitized = stripQuoted(stripHeredocs(ungluedAssignments(command)));
  const segments = sanitized.split(/&&|\|\||;|\|/);

  for (const segment of segments) {
    if (findHooksPathBypass(segment)) {
      process.stderr.write(
        "Blocked by SYVEKA guardrail (block-no-verify): this command overrides " +
          "core.hooksPath, which disables repository verification hooks. Per CLAUDE.md §9, " +
          "bypassing verification hooks requires a human to run the command directly, not the agent.\n",
      );
      process.exit(2);
    }
    const bypass = findNoVerifyBypass(segment);
    if (bypass) {
      process.stderr.write(
        `Blocked by SYVEKA guardrail (block-no-verify): "${bypass}" bypasses git verification hooks. ` +
          "Per CLAUDE.md §9, this requires a human to run the command directly, not the agent.\n",
      );
      process.exit(2);
    }
  }

  process.exit(0);
}

main();
