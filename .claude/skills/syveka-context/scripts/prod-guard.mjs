#!/usr/bin/env node
// PreToolUse guard registered by the Syveka diagnostic/audit/release skills (via
// their `hooks:` frontmatter). Once one of those skills is invoked, the guard stays
// active for the rest of the session and blocks agent-initiated commands that could
// mutate production/staging infrastructure, databases, secrets, or protected git
// state, or that would print secret values (CLAUDE.md §1, §9).
//
// Like block-no-verify, there is deliberately no override flag: a human who has
// authorized a specific protected action runs it themselves, in their own terminal.
// The guard is a backstop, not the policy — the skills' human gates still apply.

const SECRET_NAME =
  /(DATABASE_URL|DIRECT_URL|SERVICE_ROLE|SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|_KEY\b)/i;

const VERCEL_READ_ONLY = new Set([
  "ls",
  "list",
  "inspect",
  "logs",
  "whoami",
  "--version",
  "-v",
  "help",
]);
const VERCEL_READ_ONLY_PAIRS =
  /^(alias|aliases|env|domains|domain|project|projects|certs|dns)\s+(ls|list)\b/;

const READ_ONLY_SQL_FILES = [
  /prisma\/sql\/006_legacy_baseline_preflight\.sql$/,
  /tests\/staging\/[\w-]*invariants\.sql$/,
];

const SQL_WRITE =
  /\b(insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s|truncate\s|alter\s|create\s|grant\s|revoke\s|vacuum\b|reindex\b|copy\s+\S+\s+from)/i;

const BLOCKED_MCP_TOOLS = [
  /^mcp__github__merge_pull_request$/,
  /^mcp__github__enable_pr_auto_merge$/,
  /^mcp__github__actions_run_trigger$/,
  /^mcp__github__delete_file$/,
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

function stripHeredocs(command) {
  return command.replace(
    /<<-?~?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?\n\2\b/g,
    "<<HEREDOC>>",
  );
}

function stripQuoted(command) {
  return command.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function splitSegments(command) {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Returns the args after `tool` when the segment invokes it (directly or via npx).
function argsAfter(segment, tool) {
  const match = new RegExp(`(?:^|\\s|/)(?:npx\\s+(?:-y\\s+)?)?${tool}(?:@\\S+)?\\s*(.*)$`).exec(
    segment,
  );
  return match ? match[1].trim() : null;
}

function checkVercel(segment) {
  const args = argsAfter(segment, "vercel");
  if (args === null) return null;
  const sub =
    args.split(/\s+/).filter((t) => t && !t.startsWith("--scope") && !t.startsWith("--token"))[0] ??
    "";
  if (VERCEL_READ_ONLY.has(sub) || VERCEL_READ_ONLY_PAIRS.test(args)) return null;
  return `vercel ${sub || "(deploy)"} can change deployments, aliases, domains, or environment variables`;
}

function checkPrisma(segment) {
  if (/npm\s+run\s+db:(migrate|deploy|seed)\b/.test(segment)) {
    return "npm run db:* migrates or seeds a database";
  }
  const args = argsAfter(segment, "prisma");
  if (args === null) return null;
  if (/^migrate\s+(deploy|dev|reset|resolve)\b/.test(args))
    return `prisma ${args.split(/\s+/).slice(0, 2).join(" ")} writes to a database`;
  if (/^db\s+(push|execute|seed)\b/.test(args))
    return `prisma ${args.split(/\s+/).slice(0, 2).join(" ")} writes to a database`;
  return null;
}

function checkSupabase(segment) {
  const args = argsAfter(segment, "supabase");
  if (args === null) return null;
  if (
    /^(db\s+(push|reset)|migration\s+(up|repair|squash)|secrets\s+(set|unset)|functions\s+(deploy|delete)|projects\s+delete|link|config\s+push|storage\s+(rm|cp|mv))\b/.test(
      args,
    )
  ) {
    return `supabase ${args.split(/\s+/).slice(0, 2).join(" ")} changes a Supabase project`;
  }
  return null;
}

function checkPsql(rawSegment) {
  if (!/(^|\s|\/)psql\b/.test(rawSegment)) return null;
  if (SQL_WRITE.test(rawSegment)) return "psql with a write/DDL statement";
  const file = /\s-f\s+(\S+)/.exec(rawSegment)?.[1];
  if (file && !READ_ONLY_SQL_FILES.some((re) => re.test(file.replace(/['"]/g, "")))) {
    return `psql -f ${file} is not one of the documented read-only assertion files`;
  }
  return null;
}

function checkGit(segment) {
  if (!/(^|\s)git\s/.test(segment)) return null;
  if (/\bgit\s+push\b/.test(segment)) {
    if (/\s(--force|--force-with-lease|-f|--mirror|--delete|-d)\b|\s\+\S/.test(segment)) {
      return "force/delete git push";
    }
    if (/\s(\S+:)?(refs\/heads\/)?(main|master)\s*$/.test(segment)) return "git push to main";
  }
  if (/\bgit\s+reset\s+--hard\b/.test(segment)) return "git reset --hard discards work";
  if (/\bgit\s+clean\s+-\w*f/.test(segment)) return "git clean -f deletes untracked files";
  if (/\bgit\s+branch\s+-(D|d)\b/.test(segment)) return "git branch deletion";
  if (/\bgit\s+(filter-branch|filter-repo)\b/.test(segment)) return "history rewrite";
  return null;
}

function checkGh(segment) {
  if (!/(^|\s)gh\s/.test(segment)) return null;
  if (/\bgh\s+pr\s+merge\b/.test(segment)) return "gh pr merge";
  if (/\bgh\s+workflow\s+(run|enable|disable)\b/.test(segment))
    return "gh workflow dispatch/enable/disable";
  if (/\bgh\s+(secret|variable)\s+(set|delete|remove)\b/.test(segment))
    return "gh secret/variable change";
  if (/\bgh\s+release\s+(create|delete|edit)\b/.test(segment)) return "gh release change";
  if (/\bgh\s+api\b/.test(segment) && /(-X|--method)\s*(POST|PUT|PATCH|DELETE)/i.test(segment)) {
    return "mutating gh api call";
  }
  return null;
}

function checkHttp(segment) {
  if (!/(^|\s)(curl|wget|http|https)\s/.test(segment)) return null;
  const mutating = /(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b|\s(-d|--data\S*|-F|--form)\s/i.test(
    segment,
  );
  if (
    mutating &&
    /(api\.vercel\.com|supabase\.(co|com)|syveka|vercel\.app|upstash\.io|qstash)/i.test(segment)
  ) {
    return "mutating HTTP request to Vercel/Supabase/Upstash/Syveka";
  }
  return null;
}

function checkSecretExposure(rawSegment, segment) {
  if (/^(printenv|env|export\s+-p|set)\s*$/.test(segment)) return "dumping the whole environment";
  const printed = /(printenv|echo|printf)\s+[^|]*/.exec(rawSegment)?.[0] ?? "";
  if (printed && (/\$\{?\w*/.test(printed) || /^printenv\s+\w/.test(printed))) {
    const names = printed.match(/\$\{?([A-Za-z_]\w*)|printenv\s+([A-Za-z_]\w*)/g) ?? [];
    if (names.some((n) => SECRET_NAME.test(n))) return "printing a secret-bearing variable";
  }
  if (
    /\b(cat|less|more|head|tail|bat|type)\s+[^|;&]*\.env(\.(?!example\b)[\w.]+)?(\s|$)/.test(
      rawSegment,
    )
  ) {
    return "reading a .env file";
  }
  if (/\bvercel\s+env\s+pull\b/.test(rawSegment)) return "pulling Vercel env vars to disk";
  return null;
}

function evaluate(toolName, toolInput) {
  if (BLOCKED_MCP_TOOLS.some((re) => re.test(toolName ?? ""))) {
    return `${toolName} is a protected action (merge / workflow dispatch / file deletion)`;
  }
  const command = toolInput?.command;
  if (typeof command !== "string" || command.trim() === "") return null;

  const withoutHeredocs = stripHeredocs(command);
  const rawSegments = splitSegments(withoutHeredocs);
  for (const raw of rawSegments) {
    const segment = stripQuoted(raw);
    const reason =
      checkSecretExposure(raw, segment) ||
      checkVercel(segment) ||
      checkPrisma(segment) ||
      checkSupabase(segment) ||
      checkPsql(raw) ||
      checkGit(segment) ||
      checkGh(segment) ||
      checkHttp(raw);
    if (reason) return reason;
  }
  return null;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  const reason = evaluate(payload?.tool_name, payload?.tool_input);
  if (!reason) process.exit(0);
  process.stderr.write(
    `Blocked by SYVEKA guardrail (prod-guard): ${reason}. Syveka skills are read-only for ` +
      "production/staging infrastructure, databases, secrets, and protected git state " +
      "(CLAUDE.md §1, §9). Report the exact command to the human; if they authorize it, " +
      "they run it themselves.\n",
  );
  process.exit(2);
}

main();
