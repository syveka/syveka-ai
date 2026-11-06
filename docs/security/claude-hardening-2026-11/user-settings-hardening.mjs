#!/usr/bin/env node
// Owner-run proposal for ~/.claude/settings.json. Prints the changes by default; writes only
// with --apply, after saving a timestamped backup beside the file. It removes stale one-off
// allow rules and narrows broad ones: it never adds an allow rule and never touches `ask`,
// `deny`, hooks, plugins or MCP servers. Run it when no other Claude Code session is open.
//
//   node user-settings-hardening.mjs [--file <settings.json>] [--apply]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NARROWED = new Map([
  ["Bash(npm test *)", ["Bash(npm test)", "Bash(npm test -- tests/*)"]],
  ["Bash(npm ci *)", ["Bash(npm ci)"]],
  ["Bash(git fetch *)", ["Bash(git fetch origin)", "Bash(git fetch origin *)"]],
]);

const STALE = [
  // One-off commands approved once: compound commands and fixed argument lists.
  /^Bash\(cd /,
  /^Bash\(rm /,
  /^Bash\(awk /,
  /^Bash\(grep /,
  /^Bash\(echo /,
  /^Bash\(node --check /,
  /^Bash\(git (-c|--no-pager) /,
  /^Bash\(gh pr create /,
  // Temporary directories of finished sessions.
  /^Read\(.*\/AppData\/Local\/Temp\//,
  // Never used in the retained transcripts; creating a project should prompt.
  /^mcp__stitch__create_project$/,
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const file = argument("--file") ?? path.join(os.homedir(), ".claude", "settings.json");
const apply = process.argv.includes("--apply");
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
const allow = settings.permissions?.allow ?? [];

const removed = allow.filter((rule) => STALE.some((pattern) => pattern.test(rule)));
const next = [];
for (const rule of allow) {
  if (removed.includes(rule)) continue;
  for (const replacement of NARROWED.get(rule) ?? [rule]) {
    if (!next.includes(replacement)) next.push(replacement);
  }
}
const narrowed = allow.filter((rule) => NARROWED.has(rule));

console.log(`${file}: ${allow.length} allow rules, ${next.length} after this change`);
for (const rule of removed) console.log(`  remove  ${rule.slice(0, 100)}`);
for (const rule of narrowed) console.log(`  narrow  ${rule} -> ${NARROWED.get(rule).join(", ")}`);

if (!apply) {
  console.log("Dry run: nothing written. Add --apply to write it.");
} else if (!removed.length && !narrowed.length) {
  console.log("Nothing to change.");
} else {
  const backup = `${file}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  fs.copyFileSync(file, backup);
  settings.permissions.allow = next;
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Written. Backup: ${backup}`);
}
