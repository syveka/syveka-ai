#!/usr/bin/env node
// PreToolUse guardrail for Bash, PowerShell and MCP tool calls (CLAUDE.md §1, §4, §9).
//
// deny (the agent may never run it; a human runs it directly if authorized):
//   git verification-hook bypasses, force pushes, pushes to main, production
//   deploy/promote/rollback, destructive remote-database resets, reading secrets or
//   credential stores, and shell writes to protected config (see config-protection).
// ask (forces a human prompt for this specific instance, even in auto mode):
//   PR merge/approval, workflow dispatch/rerun, GitHub API mutations, release/secret/
//   repo settings changes, other deployments, database migrations and clients,
//   destructive local git operations, and the staging-ops helper scripts.
//
// This is pattern analysis, not a sandbox: scripts on disk, git/gh aliases and
// obfuscated code can still evade it. It complements, not replaces, the permission
// rules, branch protection and GitHub Environment approvals.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isSensitiveText, runGuard } from "./lib/hook-io.mjs";
import {
  isOverrideEnabled,
  isSecretPath,
  protectedConfigLabel,
  resolveArgPath,
} from "./lib/protected-paths.mjs";
import { commandName, parseScript, stringLiterals } from "./lib/shell-parse.mjs";

const SECRET_NAME =
  /SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SERVICE_ROLE|CREDENTIAL|DATABASE_URL|DIRECT_URL|DSN|CONNECTION_STRING|SIGNING_KEY|ENCRYPTION_KEY|(^|_)AUTH(_|$)/i;
const NOT_SECRET_NAME = /^(NEXT_PUBLIC_\w+|SSH_AUTH_SOCK|GIT_(AUTHOR|COMMITTER)_\w+)$/i;
const HOOK_BYPASS_ENV =
  /^(HUSKY|HUSKY_SKIP_HOOKS|SKIP|SKIP_HOOKS|LEFTHOOK|LEFTHOOK_EXCLUDE|PRE_COMMIT_ALLOW_NO_CONFIG|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM)$/i;
const STAGING_OPS = /approve-staging-gate|merge-staging-pr|dispatch-staging-release/i;
const PROTECTED_API_HOST =
  /(^|\.)(api\.github\.com|api\.vercel\.com|api\.supabase\.com|supabase\.co|api\.stripe\.com|api\.vapi\.ai)$|syveka/i;

const METADATA_COMMANDS = new Set([
  "ls",
  "dir",
  "stat",
  "test",
  "[",
  "[[",
  "test-path",
  "file",
  "find",
  "du",
  "get-childitem",
  "gci",
  "get-item",
  "gi",
  "wc",
  "echo",
  "printf",
  "write-output",
  "write-host",
]);
const DELETE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "clear-content",
  "clc",
]);
const MOVE_COMMANDS = new Set([
  "mv",
  "move",
  "move-item",
  "mi",
  "rename-item",
  "ren",
  "rni",
  "rename",
]);
const COPY_COMMANDS = new Set([
  "cp",
  "copy",
  "copy-item",
  "cpi",
  "install",
  "rsync",
  "xcopy",
  "robocopy",
]);
const WRITE_COMMANDS = new Set([
  "touch",
  "truncate",
  "tee",
  "tee-object",
  "set-content",
  "sc",
  "add-content",
  "ac",
  "out-file",
  "new-item",
  "ni",
  "chmod",
  "chown",
  "attrib",
  "icacls",
  "ln",
  "mklink",
  "patch",
  "set-itemproperty",
]);
const DB_CLIENTS = new Set([
  "psql",
  "pg_dump",
  "pg_dumpall",
  "pg_restore",
  "dropdb",
  "createdb",
  "dropuser",
  "createuser",
  "mysql",
  "mongosh",
  "mongo",
  "redis-cli",
]);
const INLINE_CODE_FLAGS = {
  node: ["-e", "--eval", "-p", "--print", "-pe"],
  nodejs: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  python: ["-c"],
  python3: ["-c"],
  py: ["-c"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
};
const DB_NPM_SCRIPTS = {
  "db:migrate": "runs `prisma migrate dev` against the configured database",
  "db:deploy": "runs `prisma migrate deploy` against the configured database",
  "db:seed": "seeds the configured database",
  "db:studio": "opens Prisma Studio with write access to the configured database",
};

function isSecretName(name) {
  return SECRET_NAME.test(name) && !NOT_SECRET_NAME.test(name);
}

function isFlag(word) {
  return word.startsWith("-") && word !== "-" && word !== "--";
}

function prefixOf(option, name, minLength) {
  return name.length >= minLength && option.startsWith(name);
}

function resolveDir(arg, cwd) {
  if (!arg) return cwd;
  let p = String(arg).replace(/\\/g, "/");
  const msys = /^\/([a-z])\/(.*)$/i.exec(p);
  if (msys) p = `${msys[1]}:/${msys[2]}`;
  return path.resolve(cwd, p);
}

function currentBranch(dir) {
  try {
    return execFileSync("git", ["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
    }).trim();
  } catch {
    return null;
  }
}

function isMainBranch(ref) {
  const name = String(ref ?? "")
    .replace(/^(refs\/)?heads\//, "")
    .toLowerCase();
  return name === "main" || name === "master";
}

function makeContext(payload) {
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const verdict = { deny: [], ask: [] };
  return {
    cwd,
    projectDir,
    verdict,
    deny: (reason) => verdict.deny.push(reason),
    ask: (reason) => verdict.ask.push(reason),
  };
}

// ---------------------------------------------------------------------------
// Script inspection

function newState(ctx, source) {
  return { cwd: ctx.cwd, assigns: new Set(), values: new Map(), rootSource: String(source ?? "") };
}

function inspectScript(source, dialect, ctx, depth, state = newState(ctx, source)) {
  const parsed = parseScript(source, dialect, depth);
  if (parsed.opaque.length && isSensitiveText(source)) {
    ctx.deny(`the command could not be fully inspected (${parsed.opaque[0]})`);
  }
  const text = String(source);
  // Environment variables set through PowerShell/.NET instead of `$env:X = ...`.
  for (const m of text.matchAll(
    /Set-Item\s+(?:-Path\s+)?env:[\\/]?(\w+)|SetEnvironmentVariable\s*\(\s*['"](\w+)['"]/gi,
  )) {
    state.assigns.add(m[1] || m[2]);
  }
  for (const m of text.matchAll(/ENVIRON\s*\[\s*["'](\w+)["']\s*\]/g)) {
    if (isSecretName(m[1])) ctx.deny(`reads the secret-bearing environment variable ${m[1]}`);
  }
  if (/\bENVIRON\b(?!\s*\[)|\bps\s+\S*e\S*ww|\$\{!\w*\*?\}/.test(text)) {
    ctx.deny("dumps environment variables");
  }
  // PowerShell .NET calls ([IO.File]::ReadAllText(...), [scriptblock]::Create(...)) carry
  // their paths and code in string literals.
  if (dialect === "powershell" && /\]\s*::/.test(text)) inspectCode(text, ctx, state, depth);
  for (const name of parsed.envReads) {
    if (isSecretName(name)) ctx.deny(`reads the secret-bearing environment variable ${name}`);
  }
  for (const name of parsed.envWrites) state.assigns.add(name);
  for (const m of String(source).matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) {
    if (isSecretName(m[1])) ctx.deny(`reads the secret-bearing environment variable ${m[1]}`);
  }
  if (/\[(System\.)?Environment\]::GetEnvironmentVariables\s*\(/i.test(source)) {
    ctx.deny("dumps every environment variable");
  }
  for (const m of String(source).matchAll(
    /\[(?:System\.)?Environment\]::GetEnvironmentVariable\s*\(\s*['"]([^'"]+)['"]/gi,
  )) {
    if (isSecretName(m[1])) ctx.deny(`reads the secret-bearing environment variable ${m[1]}`);
  }
  for (const command of parsed.commands) inspectCommand(command, ctx, state);
}

function inspectCommand(command, ctx, state) {
  let words = [...command.words];
  const { depth } = command;
  const assigns = [];
  const hereStrings = [];

  for (const redirect of command.redirects) {
    if (redirect.op.endsWith("<<<")) {
      if (redirect.target !== null) hereStrings.push(redirect.target);
      continue;
    }
    if (!redirect.target) continue;
    const abs = resolveArgPath(redirect.target, state.cwd);
    if (redirect.op.includes("<") && isSecretPath(abs)) {
      ctx.deny(`reads a secret file (${redirect.target})`);
    }
    if (redirect.op.includes(">")) {
      checkConfigWrite(abs, redirect.target, ctx, state);
      if (isSecretPath(abs) && !protectedConfigLabel(abs, roots(ctx, state))) {
        ctx.deny(`writes to a credential store (${redirect.target})`);
      }
    }
  }

  // PowerShell `$x = <command>` / `$env:X = value` — the right-hand side may run a command.
  const psGlued = /^\$(?:env:)?(\w+)=(.*)$/i.exec(words[0] ?? "");
  if (psGlued && words.length === 1) {
    state.values.set(psGlued[1], psGlued[2]);
    return;
  }
  const psAssign = /^\$(?:env:)?([\w]+)$/i.exec(words[0] ?? "");
  if (words.length >= 2 && /^\$[\w:{}]+$/.test(words[0]) && words[1] === "=") {
    if (psAssign && words.length === 3) state.values.set(psAssign[1], words[2]);
    words = words.slice(2);
    if (words.length === 1 && !/^[\w-]+$/.test(words[0])) return;
  } else if (words.length && /^\$[\w:{}]+=/.test(words[0])) {
    words = [words[0].replace(/^\$[\w:{}]+=/, ""), ...words.slice(1)].filter(Boolean);
  }
  const inlineValues = [];
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const word = words.shift();
    const eq = word.indexOf("=");
    assigns.push(word.slice(0, eq));
    inlineValues.push([word.slice(0, eq), word.slice(eq + 1)]);
  }
  if (!words.length) {
    for (const name of assigns) state.assigns.add(name);
    for (const [key, value] of inlineValues) state.values.set(key, value);
    return;
  }

  // Substitute variables whose literal values were assigned earlier in the script, so
  // `p=.env.local; cat "$p"` is inspected as `cat .env.local`.
  words = words.map((w) =>
    w.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, v) => (state.values.has(v) ? state.values.get(v) : m)),
  );

  // A command name built at run time (`$G push`, `{git,push}`, `git${IFS}push`) can't be
  // matched against the rules; block it when the command looks security-sensitive.
  if (/[$`{]|\bIFS\b/.test(words[0]) && isSensitiveText(state.rootSource)) {
    ctx.deny("runs a command whose name is computed at run time, so it cannot be inspected");
  }

  words = unwrap(words, command, ctx, state, assigns);
  if (!words || !words.length) return;

  const name = commandName(words[0]);
  const args = words.slice(1);

  const runsHelper =
    STAGING_OPS.test(words[0]) ||
    (["bash", "sh", "zsh", "source", ".", "git-bash"].includes(name) &&
      args.some((a) => STAGING_OPS.test(a)));
  if (runsHelper) {
    ctx.ask("runs a staging-operations helper (environment approval, merge or release dispatch)");
  }

  switch (name) {
    case "cd":
    case "chdir":
    case "pushd":
    case "set-location":
    case "sl":
      state.cwd = resolveDir(
        args.find((a) => !isFlag(a)),
        state.cwd,
      );
      return;
    case "export":
    case "declare":
    case "typeset":
    case "readonly":
    case "local":
      if (!args.some((a) => !isFlag(a))) ctx.deny("dumps environment variables");
      for (const a of args) if (!isFlag(a)) state.assigns.add(a.split("=")[0]);
      return;
    case "set":
      if (!args.length) ctx.deny("dumps environment variables");
      else if (/^[A-Za-z_]\w*=/.test(args[0])) state.assigns.add(args[0].split("=")[0]);
      return;
    case "printenv":
      if (!args.length || args.some((a) => isSecretName(a))) {
        ctx.deny("prints environment variables that may contain secrets");
      }
      return;
    case "git":
      inspectGit(args, ctx, state, assigns);
      break;
    case "gh":
      inspectGh(args, ctx);
      break;
    case "vercel":
      inspectVercel(args, ctx);
      break;
    case "supabase":
      inspectSupabase(args, ctx);
      break;
    case "prisma":
      inspectPrisma(args, ctx);
      break;
    case "curl":
    case "wget":
    case "invoke-webrequest":
    case "iwr":
    case "invoke-restmethod":
    case "irm":
    case "http":
    case "https":
      inspectHttp(name, args, ctx);
      break;
    default:
      if (DB_CLIENTS.has(name) && !args.some((a) => /^(--version|-V|--help|-\?)$/.test(a))) {
        ctx.ask(`opens a direct database client (${name})`);
      }
  }

  if (
    [
      "get-childitem",
      "gci",
      "dir",
      "ls",
      "get-item",
      "gi",
      "get-content",
      "gc",
      "cat",
      "type",
    ].includes(name)
  ) {
    for (const a of args) {
      const m = /^env:[\\/]?(.*)$/i.exec(a);
      if (m && (!m[1] || m[1].includes("*") || isSecretName(m[1]))) {
        ctx.deny("reads environment variables that may contain secrets");
      }
    }
  }

  inspectInlineCode(name, args, command, ctx, state, depth, hereStrings);
  inspectFileArguments(name, args, ctx, state);
  inspectRecursiveSearch(name, args, ctx, state);
  inspectFind(name, args, ctx, state, depth);
}

function roots(ctx, state) {
  return [ctx.projectDir, ctx.cwd, state.cwd];
}

function checkConfigWrite(abs, display, ctx, state) {
  const label = protectedConfigLabel(abs, roots(ctx, state));
  if (label && !isOverrideEnabled()) {
    ctx.deny(`modifies protected configuration "${label}" (see config-protection)`);
  }
}

// Strips wrappers (sudo, env, npx, bash -c, pwsh -Command, docker exec, ...) and
// recurses into embedded scripts. Returns the remaining words, or null if handled.
function unwrap(initialWords, command, ctx, state, assigns) {
  let words = initialWords;
  const nestedDepth = command.depth + 1;
  for (let guard = 0; guard < 12 && words.length; guard++) {
    const name = commandName(words[0]);
    const rest = words.slice(1);

    if (name === "sudo" || name === "doas") {
      let i = 0;
      while (i < rest.length && isFlag(rest[i]))
        i += ["-u", "-g", "-h", "-p"].includes(rest[i]) ? 2 : 1;
      words = rest.slice(i);
      continue;
    }
    if (name === "env") {
      let i = 0;
      while (i < rest.length) {
        const w = rest[i];
        if (w === "-u" || w === "--unset" || w === "-C" || w === "--chdir" || w === "-S") i += 2;
        else if (isFlag(w)) i += 1;
        else if (/^[A-Za-z_]\w*=/.test(w)) {
          assigns.push(w.split("=")[0]);
          i += 1;
        } else break;
      }
      if (i >= rest.length) {
        ctx.deny("dumps environment variables");
        return null;
      }
      words = rest.slice(i);
      continue;
    }
    if (
      ["command", "builtin", "exec", "nohup", "time", "stdbuf", "unbuffer", "caffeinate"].includes(
        name,
      )
    ) {
      let i = 0;
      while (i < rest.length && isFlag(rest[i])) i++;
      words = rest.slice(i);
      continue;
    }
    if (name === "nice" || name === "ionice") {
      let i = 0;
      while (i < rest.length && isFlag(rest[i])) i += rest[i] === "-n" || rest[i] === "-c" ? 2 : 1;
      words = rest.slice(i);
      continue;
    }
    if (name === "timeout") {
      let i = 0;
      while (i < rest.length && isFlag(rest[i])) i += rest[i] === "-s" || rest[i] === "-k" ? 2 : 1;
      words = rest.slice(i + 1);
      continue;
    }
    if (name === "xargs") {
      let i = 0;
      const withValue = [
        "-I",
        "-n",
        "-P",
        "-L",
        "-d",
        "-s",
        "-E",
        "-a",
        "--arg-file",
        "--delimiter",
      ];
      while (i < rest.length && isFlag(rest[i])) i += withValue.includes(rest[i]) ? 2 : 1;
      words = rest.slice(i);
      continue;
    }
    if (["npx", "bunx", "pnpx"].includes(name)) {
      let i = 0;
      while (i < rest.length && isFlag(rest[i])) {
        if (rest[i] === "-c" || rest[i] === "--call") {
          inspectScript(rest[i + 1] ?? "", "bash", ctx, nestedDepth, state);
          return null;
        }
        i += ["-p", "--package"].includes(rest[i]) ? 2 : 1;
      }
      words = stripPackageVersion(rest.slice(i));
      continue;
    }
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
      const sub = rest[0];
      if (["exec", "x", "dlx"].includes(sub)) {
        let i = 1;
        while (i < rest.length && (isFlag(rest[i]) || rest[i] === "--")) {
          if (rest[i] === "-c" || rest[i] === "--call") {
            inspectScript(rest[i + 1] ?? "", "bash", ctx, nestedDepth, state);
            return null;
          }
          i += ["-p", "--package"].includes(rest[i]) ? 2 : 1;
        }
        words = stripPackageVersion(rest.slice(i));
        continue;
      }
      const script = ["run", "run-script", "rum", "urn"].includes(sub)
        ? rest[1]
        : name !== "npm"
          ? sub
          : null;
      if (script && DB_NPM_SCRIPTS[script]) {
        ctx.ask(`\`${name} run ${script}\` ${DB_NPM_SCRIPTS[script]}`);
        return null;
      }
      if (name !== "npm" && ["prisma", "vercel", "supabase"].includes(sub)) {
        words = rest;
        continue;
      }
      return words;
    }
    if (["dotenv", "dotenvx", "with-env"].includes(name)) {
      const dashDash = rest.indexOf("--");
      words = dashDash === -1 ? rest.filter((w) => !isFlag(w)).slice(1) : rest.slice(dashDash + 1);
      continue;
    }
    if (name === "cmd" && /^\/[ck]$/i.test(rest[0] ?? "")) {
      // cmd.exe: backslashes are literal and ^ is the escape character.
      const script = rest.slice(1).join(" ").replace(/\^(.)/g, "$1");
      inspectScript(script, "powershell", ctx, nestedDepth, state);
      return null;
    }
    if (["bash", "sh", "zsh", "dash", "ksh", "git-bash", "busybox"].includes(name)) {
      const args = name === "busybox" ? rest.slice(1) : rest;
      const cIndex = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (cIndex !== -1) {
        const script = args.slice(cIndex + 1).find((a) => !isFlag(a)) ?? "";
        if (/\$\(\.\.\.\)|`\.\.\.`/.test(script) && isSensitiveText(state.rootSource)) {
          ctx.deny(
            "runs a shell script built from command substitution, which cannot be inspected",
          );
        }
        inspectScript(script, "bash", ctx, nestedDepth, state);
        return null;
      }
      for (const body of command.heredocs) inspectScript(body, "bash", ctx, nestedDepth, state);
      const hereStrings = command.redirects.filter((r) => r.op.endsWith("<<<") && r.target);
      for (const r of hereStrings) inspectScript(r.target, "bash", ctx, nestedDepth, state);
      const runsFile = args.some((a) => !isFlag(a));
      if (!runsFile && !command.heredocs.length && !hereStrings.length) {
        stdinScript(ctx, state);
      }
      return words;
    }
    if (["pwsh", "powershell"].includes(name)) {
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i].toLowerCase();
        if (!p.startsWith("-")) continue;
        // pwsh accepts -e, -ec and any unambiguous prefix of -EncodedCommand.
        if (p === "-e" || p === "-ec" || prefixOf("-encodedcommand", p, 3)) {
          ctx.deny("runs a base64-encoded PowerShell command that cannot be inspected");
          return null;
        }
        if (p === "-c" || prefixOf("-command", p, 3)) {
          inspectScript(rest.slice(i + 1).join(" "), "powershell", ctx, nestedDepth, state);
          return null;
        }
        if (
          ["-executionpolicy", "-ep", "-ex", "-file", "-f", "-workingdirectory", "-wd"].includes(p)
        )
          i++;
      }
      for (const body of command.heredocs)
        inspectScript(body, "powershell", ctx, nestedDepth, state);
      if (!rest.some((a) => !a.startsWith("-")) && !command.heredocs.length) {
        stdinScript(ctx, state);
      }
      return words;
    }
    if (name === "invoke-expression" || name === "iex") {
      const code = rest.filter((w) => !/^-command$/i.test(w)).join(" ");
      if (!code.trim()) stdinScript(ctx, state);
      inspectScript(code, "powershell", ctx, nestedDepth, state);
      return null;
    }
    if (
      name === "node" &&
      /node_modules[\\/](\.bin[\\/])?(vercel|supabase|prisma)\b/i.test(rest[0] ?? "")
    ) {
      const tool = /node_modules[\\/](?:\.bin[\\/])?(vercel|supabase|prisma)\b/i.exec(rest[0])[1];
      words = [tool.toLowerCase(), ...rest.slice(1)];
      continue;
    }
    if (name === "eval") {
      inspectScript(rest.join(" "), "bash", ctx, nestedDepth, state);
      return null;
    }
    if (
      name === "start-process" ||
      name === "saps" ||
      (name === "start" && command.dialect === "powershell")
    ) {
      let file = null;
      const argList = [];
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i].toLowerCase();
        if (p === "-filepath") file = rest[++i];
        else if (p === "-argumentlist" || p === "-args")
          argList.push(...(rest[++i] ?? "").split(","));
        else if (p.startsWith("-")) {
          if (
            [
              "-workingdirectory",
              "-verb",
              "-redirectstandardoutput",
              "-redirectstandarderror",
            ].includes(p)
          )
            i++;
        } else if (file === null) file = rest[i];
        else argList.push(...rest[i].split(","));
      }
      inspectScript([file ?? "", ...argList].join(" "), "powershell", ctx, nestedDepth, state);
      return null;
    }
    if (
      (name === "docker" || name === "podman") &&
      (rest[0] === "exec" || (rest[0] === "compose" && rest[1] === "exec"))
    ) {
      let i = rest[0] === "compose" ? 2 : 1;
      const withValue = ["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--index"];
      while (i < rest.length && isFlag(rest[i])) i += withValue.includes(rest[i]) ? 2 : 1;
      words = rest.slice(i + 1);
      continue;
    }
    if (name === "wsl") {
      let i = 0;
      while (i < rest.length && isFlag(rest[i]))
        i += ["-d", "--distribution", "-u", "--user", "--cd"].includes(rest[i]) ? 2 : 1;
      words = rest.slice(i);
      continue;
    }
    if (words[0] === "&" || words[0] === ".") {
      words = rest;
      continue;
    }
    return words;
  }
  return words;
}

// A shell or Invoke-Expression reading its script from stdin (e.g. `echo ... | bash`)
// can't be inspected; block it when the surrounding command looks security-sensitive.
function stdinScript(ctx, state) {
  if (isSensitiveText(state.rootSource)) {
    ctx.deny("pipes a script into a shell, so the command it runs cannot be inspected");
  }
}

function stripPackageVersion(words) {
  if (!words.length) return words;
  const [first, ...rest] = words;
  const at = first.lastIndexOf("@");
  return [at > 0 ? first.slice(0, at) : first, ...rest];
}

// ---------------------------------------------------------------------------
// git

function inspectGit(args, ctx, state, assigns) {
  let gitCwd = state.cwd;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (a === "-c") {
      inspectGitConfigPair(args[i + 1] ?? "", ctx);
      i += 2;
      continue;
    }
    if (a.startsWith("--config-env")) {
      inspectGitConfigPair(a.includes("=") ? a.slice(a.indexOf("=") + 1) : (args[++i] ?? ""), ctx);
      i++;
      continue;
    }
    if (a === "-C") {
      gitCwd = resolveDir(args[i + 1], gitCwd);
      i += 2;
      continue;
    }
    if (["--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"].includes(a)) {
      i += 2;
      continue;
    }
    i++;
  }
  const allAssigns = [...assigns, ...state.assigns];
  const bypassVar = allAssigns.find((n) => HOOK_BYPASS_ENV.test(n));
  if (bypassVar) {
    ctx.deny(`sets ${bypassVar}, which can disable or reconfigure git verification hooks`);
  }

  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return;
  const hasNoVerify = rest.some((a) => prefixOf("--no-verify", a.split("=")[0], 9));

  switch (sub) {
    case "commit":
      if (hasNoVerify || shortClusterHas(rest, "n", "mFcCtSu")) {
        ctx.deny("`git commit --no-verify`/`-n` bypasses git verification hooks");
      }
      break;
    case "push":
      inspectGitPush(rest, ctx, gitCwd);
      break;
    case "merge":
    case "am":
    case "cherry-pick":
    case "revert":
    case "pull":
      if (hasNoVerify) ctx.deny(`\`git ${sub} --no-verify\` bypasses git verification hooks`);
      if (sub === "am") ctx.ask("`git am` applies patches that can modify any file");
      break;
    case "apply":
      if (!rest.some((a) => ["--check", "--stat", "--numstat", "--summary"].includes(a))) {
        ctx.ask("`git apply` applies a patch that can modify any file, including protected config");
      }
      break;
    case "rebase":
      if (hasNoVerify) ctx.deny("`git rebase --no-verify` bypasses git verification hooks");
      if (!rest.some((a) => ["--abort", "--continue", "--skip", "--quit"].includes(a))) {
        ctx.ask("`git rebase` rewrites history");
      }
      break;
    case "reset":
      if (rest.some((a) => a.startsWith("--ha")))
        ctx.ask("`git reset --hard` discards uncommitted work");
      break;
    case "checkout": {
      const valueFlags = ["-b", "-B", "--orphan", "--conflict", "--pathspec-from-file"];
      const positional = [];
      for (let k = 0; k < rest.length; k++) {
        if (rest[k] === "--") {
          positional.push(...rest.slice(k + 1));
          break;
        }
        if (valueFlags.includes(rest[k])) k++;
        else if (!isFlag(rest[k])) positional.push(rest[k]);
      }
      const dashDash = rest.indexOf("--");
      const paths = dashDash !== -1 ? rest.slice(dashDash + 1) : positional.slice(1);
      for (const p of paths) checkConfigWrite(resolveArgPath(p, gitCwd), p, ctx, state);
      if (
        dashDash !== -1 ||
        positional.length > 1 ||
        rest.includes(".") ||
        rest.includes("-B") ||
        rest.some((a) => a === "--force" || a === "--for" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))
      ) {
        ctx.ask("`git checkout` with paths, -B or --force discards work or overwrites a branch");
      }
      break;
    }
    case "switch":
      if (
        rest.some((a) => ["--discard-changes", "--force", "-f", "-C", "--force-create"].includes(a))
      ) {
        ctx.ask("`git switch` with --discard-changes/--force discards work or overwrites a branch");
      }
      break;
    case "restore": {
      const stagedOnly =
        rest.some((a) => a === "--staged" || a === "-S") &&
        !rest.some((a) => a === "--worktree" || a === "-W");
      if (!stagedOnly) {
        for (let k = 0; k < rest.length; k++) {
          if (rest[k] === "--source" || rest[k] === "-s") k++;
          else if (!isFlag(rest[k]) && rest[k] !== "--") {
            checkConfigWrite(resolveArgPath(rest[k], gitCwd), rest[k], ctx, state);
          }
        }
        ctx.ask("`git restore` discards working-tree changes");
      }
      break;
    }
    case "show":
    case "cat-file":
    case "diff":
    case "grep":
    case "log":
    case "blame":
      for (const a of rest) {
        const revPath = /^[^:]*:(.+)$/.exec(a);
        if (revPath && isSecretPath(resolveArgPath(revPath[1], gitCwd))) {
          ctx.deny(`prints a secret file from git history (${a})`);
        }
      }
      break;
    case "clean": {
      const dryRun = rest.some(
        (a) => a === "--dry-run" || (/^-[a-zA-Z]+$/.test(a) && a.includes("n")),
      );
      const force = rest.some(
        (a) => a === "--force" || (/^-[a-zA-Z]+$/.test(a) && a.includes("f")),
      );
      if (force && !dryRun) ctx.ask("`git clean -f` permanently deletes untracked files");
      break;
    }
    case "stash":
      if (rest[0] === "drop" || rest[0] === "clear")
        ctx.ask(`\`git stash ${rest[0]}\` permanently discards stashed work`);
      break;
    case "branch":
      if (
        rest.some(
          (a) =>
            ["--delete", "--force", "--move"].includes(a) ||
            (/^-[a-zA-Z]+$/.test(a) && /[dDfMC]/.test(a.slice(1))),
        )
      ) {
        ctx.ask("deletes, force-moves or force-renames a branch");
      }
      break;
    case "worktree":
      if (rest[0] === "remove" || rest[0] === "prune")
        ctx.ask(`\`git worktree ${rest[0]}\` deletes worktrees`);
      break;
    case "tag":
      if (rest.some((a) => a === "-d" || a === "--delete")) ctx.ask("deletes a tag");
      break;
    case "filter-branch":
    case "filter-repo":
    case "replace":
      ctx.ask(`\`git ${sub}\` rewrites history`);
      break;
    case "update-ref":
      ctx.ask("`git update-ref` rewrites or deletes a ref directly");
      break;
    case "reflog":
      if (rest[0] === "expire" || rest[0] === "delete")
        ctx.ask("expires reflog entries (can make work unrecoverable)");
      break;
    case "gc":
      if (rest.some((a) => /^--prune=(now|all)$/.test(a)))
        ctx.ask("prunes unreachable objects immediately");
      break;
    case "config":
      inspectGitConfigCommand(rest, ctx);
      break;
    case "credential":
    case "credential-manager":
    case "credential-store":
    case "credential-cache":
      ctx.deny("can print stored git credentials");
      break;
    case "add":
      for (const a of rest) {
        if (!isFlag(a) && isSecretPath(resolveArgPath(a, gitCwd)))
          ctx.deny(`stages a secret file (${a}) for commit`);
      }
      break;
    case "rm":
    case "mv":
      for (const a of rest)
        if (!isFlag(a)) checkConfigWrite(resolveArgPath(a, gitCwd), a, ctx, state);
      break;
    default:
  }
}

// Config keys that disable hooks, hide commands, or silently re-route pushes to main.
function inspectGitConfigKey(key, value, ctx) {
  if (key === "core.hookspath") ctx.deny("sets core.hooksPath, which disables verification hooks");
  if (key.startsWith("alias.")) ctx.deny("defines a git alias, which can hide a protected command");
  if (/^remote\..+\.(push|mirror)$/.test(key)) {
    ctx.deny(`sets ${key}, which can re-route or mirror pushes (including to main)`);
  }
  if (
    key === "push.default" &&
    !["simple", "current", "nothing"].includes(String(value).toLowerCase())
  ) {
    ctx.deny(`sets push.default=${value}, which can push to main without a refspec`);
  }
}

function inspectGitConfigPair(pair, ctx) {
  const text = String(pair);
  const eq = text.indexOf("=");
  const key = (eq === -1 ? text : text.slice(0, eq)).trim().toLowerCase();
  inspectGitConfigKey(key, eq === -1 ? "true" : text.slice(eq + 1), ctx);
}

function inspectGitConfigCommand(rest, ctx) {
  const isRead = rest.some((a) =>
    /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope)$/.test(a),
  );
  const isUnset = rest.some((a) => a === "--unset" || a === "--unset-all");
  const withValue = ["--file", "-f", "--blob", "--type", "--default", "--comment"];
  let key = null;
  let value = "";
  for (let i = 0; i < rest.length; i++) {
    if (withValue.includes(rest[i])) {
      i++;
      continue;
    }
    if (isFlag(rest[i])) continue;
    if (["get", "set", "unset", "list"].includes(rest[i]) && key === null) continue;
    key = rest[i].toLowerCase();
    value = rest[i + 1] ?? "";
    break;
  }
  if (!key || isRead || isUnset || rest.includes("get") || rest.includes("list")) return;
  inspectGitConfigKey(key, value, ctx);
}

// True when a short-option cluster contains `flag`. Skips the values of value-taking
// options, so `git commit -m "-n is a flag"` is not mistaken for `-n`.
function shortClusterHas(args, flag, valueTaking) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return false;
    if (!/^-[a-zA-Z]+/.test(a) || a.startsWith("--")) continue;
    const cluster = a.slice(1);
    for (let k = 0; k < cluster.length; k++) {
      const ch = cluster[k];
      if (ch === flag) return true;
      if (valueTaking.includes(ch)) {
        if (k === cluster.length - 1) i++;
        break;
      }
    }
  }
  return false;
}

function inspectGitPush(args, ctx, gitCwd) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const name = a.split("=")[0];
      if (prefixOf("--no-verify", name, 9))
        ctx.deny("`git push --no-verify` bypasses git verification hooks");
      else if (
        ["--force", "--force-with-lease", "--force-if-includes"].some((c) =>
          prefixOf(c, name, 4),
        ) &&
        !"--follow-tags".startsWith(name)
      ) {
        ctx.deny("force-pushes, which can overwrite remote history");
      } else if (prefixOf("--mirror", name, 4))
        ctx.deny("`git push --mirror` overwrites and deletes remote refs");
      else if (name === "--all" || name === "--branches")
        ctx.deny("pushes every branch, including main");
      else if (prefixOf("--delete", name, 4)) ctx.ask("deletes a remote branch or tag");
      else if (prefixOf("--prune", name, 5)) ctx.ask("`git push --prune` deletes remote branches");
      else if (
        ["--repo", "--receive-pack", "--exec", "--push-option"].includes(name) &&
        !a.includes("=")
      )
        i++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === "f") ctx.deny("force-pushes, which can overwrite remote history");
        if (ch === "d") ctx.ask("deletes a remote branch or tag");
        if (ch === "o") {
          if (k === a.length - 1) i++;
          break;
        }
      }
      continue;
    }
    positional.push(a);
  }
  const refspecs = positional.slice(1);
  if (!refspecs.length) {
    const branch = currentBranch(gitCwd);
    if (branch === null) ctx.ask("could not determine which branch this push targets");
    else if (isMainBranch(branch)) ctx.deny("pushes directly to main");
    return;
  }
  for (const spec of refspecs) {
    let s = spec;
    if (s.startsWith("+")) {
      ctx.deny(`force-pushes via the "${spec}" refspec`);
      s = s.slice(1);
    }
    if (s.includes("*")) {
      ctx.deny(`pushes a wildcard refspec ("${spec}") that can include main`);
      continue;
    }
    let target;
    if (s.includes(":")) {
      const [src, dst] = [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)];
      if (src === "") ctx.ask(`deletes the remote ref "${dst}"`);
      target = dst;
    } else {
      target = s === "HEAD" || s === "@" ? currentBranch(gitCwd) : s;
    }
    if (target === null) ctx.ask("could not determine which branch this push targets");
    else if (isMainBranch(target)) ctx.deny("pushes directly to main");
  }
}

// ---------------------------------------------------------------------------
// GitHub CLI

function inspectGh(args, ctx) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-R" || args[i] === "--repo" || args[i] === "--hostname") {
      i++;
      continue;
    }
    if (/^(--repo|--hostname)=/.test(args[i])) continue;
    words.push(args[i]);
  }
  const [group, sub, ...rest] = words;
  switch (group) {
    case "pr":
      if (sub === "merge") ctx.ask("merges a pull request");
      if (sub === "review" && rest.some((a) => a.startsWith("--approve") || a === "-a"))
        ctx.ask("approves a pull request");
      break;
    case "run":
      if (["rerun", "cancel", "delete", "approve"].includes(sub))
        ctx.ask(`\`gh run ${sub}\` changes a workflow run`);
      break;
    case "workflow":
      if (["run", "enable", "disable"].includes(sub))
        ctx.ask(`\`gh workflow ${sub}\` dispatches or reconfigures a workflow`);
      break;
    case "release":
      if (["create", "delete", "edit", "upload", "delete-asset"].includes(sub))
        ctx.ask(`\`gh release ${sub}\` changes a release`);
      break;
    case "secret":
    case "variable":
      if (["set", "delete", "remove"].includes(sub)) ctx.ask(`changes a GitHub ${group}`);
      break;
    case "repo":
      if (
        ["edit", "delete", "rename", "archive", "unarchive", "sync", "deploy-key"].includes(sub)
      ) {
        ctx.ask(`\`gh repo ${sub}\` changes repository settings or contents`);
      }
      break;
    case "auth":
      if (
        sub === "token" ||
        (sub === "status" && rest.some((a) => a === "--show-token" || a === "-t"))
      ) {
        ctx.deny("prints the GitHub authentication token");
      } else if (["login", "logout", "refresh", "setup-git", "switch"].includes(sub)) {
        ctx.ask(`\`gh auth ${sub}\` changes GitHub authentication`);
      }
      break;
    case "alias":
      if (sub === "set" || sub === "import")
        ctx.deny("defines a gh alias, which can hide a protected command");
      break;
    case "config":
      if (sub === "get" && rest.some((a) => /token|secret|password/i.test(a))) {
        ctx.deny("prints a stored GitHub credential");
      }
      break;
    case "extension":
    case "ext":
      if (["install", "upgrade", "exec", "remove"].includes(sub))
        ctx.ask("installs or runs a gh extension");
      break;
    case "api":
      inspectGhApi(
        [sub, ...rest].filter((w) => w !== undefined),
        ctx,
      );
      return;
    default:
  }
  if (["delete", "remove", "rm"].includes(sub))
    ctx.ask(`\`gh ${group} ${sub}\` deletes GitHub data`);
}

function inspectGhApi(args, ctx) {
  let method = null;
  let hasBody = false;
  let mutation = false;
  let endpoint = null;
  const valueFlags = [
    "-H",
    "--header",
    "-q",
    "--jq",
    "-t",
    "--template",
    "--cache",
    "-p",
    "--preview",
    "--hostname",
  ];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--method") method = args[++i] ?? "";
    else if (/^-X./.test(a)) method = a.slice(2);
    else if (a.startsWith("--method=")) method = a.slice("--method=".length);
    else if (["-f", "-F", "--field", "--raw-field"].includes(a)) {
      hasBody = true;
      const value = args[++i] ?? "";
      // `query=@file` or a substituted query can't be inspected; treat it as a mutation.
      if (/mutation|=@|\$\(|`/i.test(value)) mutation = true;
    } else if (/^--(field|raw-field)=/.test(a) || /^-[fF]./.test(a)) {
      hasBody = true;
      if (/mutation|=@|\$\(|`/i.test(a)) mutation = true;
    } else if (a === "--input") {
      hasBody = true;
      mutation = true;
      i++;
    } else if (a.startsWith("--input=")) {
      hasBody = true;
      mutation = true;
    } else if (valueFlags.includes(a)) i++;
    else if (!a.startsWith("-") && endpoint === null) endpoint = a;
  }
  const verb = method ? method.toUpperCase() : null;
  if (endpoint === "graphql") {
    if (mutation) ctx.ask("runs a GitHub GraphQL mutation");
    return;
  }
  if ((verb && !["GET", "HEAD"].includes(verb)) || (!verb && hasBody)) {
    ctx.ask(`makes a mutating GitHub API call (${verb ?? "POST"} ${endpoint ?? ""})`.trim());
  }
}

// ---------------------------------------------------------------------------
// Vercel, Supabase, Prisma, HTTP

function splitArgs(args, valueFlags) {
  const positional = [];
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (isFlag(a)) {
      flags.push(a);
      if (valueFlags.includes(a) && i + 1 < args.length) flags.push(args[++i]);
    } else positional.push(a);
  }
  return { positional, flags };
}

const VERCEL_COMMANDS = new Set([
  "deploy",
  "dev",
  "build",
  "ls",
  "list",
  "inspect",
  "logs",
  "whoami",
  "help",
  "env",
  "pull",
  "promote",
  "rollback",
  "redeploy",
  "alias",
  "aliases",
  "domains",
  "domain",
  "dns",
  "certs",
  "cert",
  "remove",
  "rm",
  "project",
  "projects",
  "link",
  "git",
  "integration",
  "teams",
  "team",
  "switch",
  "login",
  "logout",
  "bisect",
  "init",
  "secrets",
  "curl",
  "api",
  "blob",
  "cache",
  "target",
  "open",
  "telemetry",
  "upgrade",
  "mcp",
  "microfrontends",
]);
const VERCEL_READ_ONLY = new Set([
  "ls",
  "list",
  "inspect",
  "logs",
  "whoami",
  "help",
  "dev",
  "build",
  "bisect",
  "open",
  "telemetry",
]);

function inspectVercel(args, ctx) {
  const { positional, flags } = splitArgs(args, [
    "--token",
    "-t",
    "--scope",
    "-S",
    "--team",
    "-T",
    "--cwd",
    "--local-config",
    "-A",
    "--global-config",
    "-Q",
    "--target",
    "-e",
    "--env",
    "-b",
    "--build-env",
    "-m",
    "--meta",
  ]);
  const prod =
    flags.some((f) => f === "--prod" || f === "--production" || /^--target=production$/i.test(f)) ||
    flags.some((f, i) => f === "--target" && /^production$/i.test(flags[i + 1] ?? ""));
  if (!positional.length && flags.some((f) => /^(--version|-v|--help|-h)$/.test(f))) return;
  const sub = positional.length && VERCEL_COMMANDS.has(positional[0]) ? positional[0] : "deploy";
  if (sub === "deploy" || sub === "redeploy") {
    if (prod)
      ctx.deny("deploys to Vercel production; production releases go through the release workflow");
    else ctx.ask(`\`vercel ${sub}\` creates a deployment`);
    return;
  }
  if ((sub === "alias" || sub === "aliases") && positional.some((p) => /syveka/i.test(p))) {
    ctx.deny("points a Syveka domain at a deployment, which changes what production serves");
    return;
  }
  if (sub === "promote" || sub === "rollback") {
    ctx.deny(`\`vercel ${sub}\` changes which build serves production`);
    return;
  }
  if (sub === "pull" || (sub === "env" && positional[1] === "pull")) {
    ctx.deny("downloads Vercel environment secrets to disk");
    return;
  }
  if (sub === "env" && ["ls", "list"].includes(positional[1])) return;
  if (VERCEL_READ_ONLY.has(sub)) return;
  ctx.ask(`\`vercel ${sub}\` changes Vercel project, domain or environment configuration`);
}

function inspectSupabase(args, ctx) {
  const { positional, flags } = splitArgs(args, [
    "--workdir",
    "--profile",
    "--network-id",
    "-o",
    "--output",
    "--project-ref",
    "--db-url",
    "-p",
    "--password",
    "--schema",
    "-s",
    "-f",
    "--file",
  ]);
  const [sub, sub2] = positional;
  if (!sub || flags.some((f) => /^(--version|-v|--help|-h)$/.test(f))) return;
  const remote = flags.some((f) => f === "--linked" || f.startsWith("--db-url"));
  switch (sub) {
    case "db":
      if (sub2 === "reset") {
        if (remote) ctx.deny("`supabase db reset` against a remote database destroys its data");
        else ctx.ask("`supabase db reset` wipes the local database");
      } else if (!["diff", "lint", "start", "test"].includes(sub2)) {
        ctx.ask(
          `\`supabase db ${sub2 ?? ""}\` reads from or writes to a database`.replace(" ``", ""),
        );
      }
      return;
    case "migration":
    case "migrations":
      if (!["new", "list"].includes(sub2))
        ctx.ask(`\`supabase migration ${sub2 ?? ""}\` changes migration state`);
      return;
    case "functions":
      if (!["serve", "new", "list", "download"].includes(sub2))
        ctx.ask(`\`supabase functions ${sub2 ?? ""}\` deploys or deletes edge functions`);
      return;
    case "start":
    case "status":
    case "init":
    case "gen":
    case "inspect":
    case "test":
    case "services":
    case "completion":
    case "help":
      return;
    case "stop":
      if (flags.includes("--no-backup"))
        ctx.ask("`supabase stop --no-backup` deletes local database data");
      return;
    default:
      if (sub === "projects" && sub2 === "api-keys") {
        ctx.deny("`supabase projects api-keys` prints the service_role key");
        return;
      }
      if (["list", "ls", "get"].includes(sub2)) return;
      ctx.ask(`\`supabase ${sub}${sub2 ? ` ${sub2}` : ""}\` changes Supabase project state`);
  }
}

function inspectPrisma(args, ctx) {
  const { positional, flags } = splitArgs(args, [
    "--schema",
    "--url",
    "--file",
    "--from-url",
    "--to-url",
  ]);
  const [sub, sub2] = positional;
  if (sub === "migrate") {
    if (sub2 === "reset") ctx.deny("`prisma migrate reset` drops and recreates the database");
    else if (!["diff", "status"].includes(sub2))
      ctx.ask(`\`prisma migrate ${sub2 ?? ""}\` applies migrations to the configured database`);
  } else if (sub === "db") {
    if (sub2 === "push" && flags.some((f) => f === "--accept-data-loss" || f === "--force-reset")) {
      ctx.deny("`prisma db push` with --accept-data-loss/--force-reset destroys data");
    } else {
      ctx.ask(`\`prisma db ${sub2 ?? ""}\` writes to or reads from the configured database`);
    }
  } else if (sub === "studio") {
    ctx.ask("Prisma Studio opens the configured database with write access");
  }
}

function inspectHttp(name, args, ctx) {
  let host = null;
  let method = null;
  let hasBody = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const lower = a.toLowerCase();
    if (host === null && !isFlag(a)) {
      // Accepts userinfo (user:pass@host), schemeless URLs and a trailing dot.
      const m =
        /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([a-z0-9.-]+\.[a-z]{2,}\.?)(?=$|[/:?#])/i.exec(
          a,
        );
      if (m) host = m[1].replace(/\.$/, "");
    }
    if (a === "-X" || a === "--request" || lower === "-method" || a === "--method")
      method = args[++i] ?? "";
    else if (/^-X./.test(a)) method = a.slice(2);
    else if (/^--(request|method)=/.test(a)) method = a.split("=")[1];
    else if (
      /^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|-T|--upload-file|--post-data|--post-file|--body-data|--body-file)$/.test(
        a,
      ) ||
      /^--(data|json|form|post-data|body-data)/.test(a) ||
      lower === "-body" ||
      lower === "-infile"
    ) {
      hasBody = true;
    }
  }
  const verb = (method || (hasBody ? "POST" : "GET")).toUpperCase();
  if (host && PROTECTED_API_HOST.test(host) && !["GET", "HEAD", "OPTIONS"].includes(verb)) {
    ctx.ask(`makes a mutating ${verb} request to ${host} via ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Inline interpreter code and file arguments

function inspectInlineCode(name, args, command, ctx, state, depth, hereStrings) {
  let interpreter = name;
  let rest = args;
  if (name === "deno" && args[0] === "eval") {
    interpreter = "node";
    rest = ["-e", ...args.slice(1)];
  }
  const flags = INLINE_CODE_FLAGS[interpreter];
  if (!flags) return;
  const code = [];
  for (let i = 0; i < rest.length; i++) {
    if (flags.includes(rest[i])) code.push(rest[i + 1] ?? "");
  }
  const readsStdin = !rest.some((a) => !isFlag(a) && !code.includes(a)) || rest.includes("-");
  if (readsStdin) code.push(...command.heredocs, ...hereStrings);
  for (const snippet of code) inspectCode(snippet, ctx, state, depth);
}

function inspectCode(code, ctx, state, depth) {
  const text = String(code);
  if (
    /process\.env(?!\s*(?:\.|\[|\?\.))/.test(text) ||
    /process\s*\[\s*['"]env['"]\s*\]|\{\s*env\s*\}\s*=\s*(?:process|require\(\s*['"](?:node:)?process['"]\s*\))|require\(\s*['"](?:node:)?process['"]\s*\)\.env/.test(
      text,
    ) ||
    /Deno\.env\.toObject|os\.environ(?!\s*(?:\.get|\[))|ENV\.to_h|%ENV\b|GetEnvironmentVariables/.test(
      text,
    )
  ) {
    ctx.deny("dumps environment variables from inline code");
  }
  const named = [
    ...text.matchAll(/process\.env\s*(?:\??\.\s*([A-Za-z_]\w*)|\[\s*['"`]([^'"`]+)['"`]\s*\])/g),
    ...text.matchAll(
      /(?:os\.environ(?:\.get)?|os\.getenv|Deno\.env\.get|ENV|GetEnvironmentVariable)\s*[[(]\s*['"]([^'"]+)['"]/g,
    ),
  ];
  for (const m of named) {
    const varName = m[1] || m[2];
    if (varName && isSecretName(varName))
      ctx.deny(`reads the secret-bearing environment variable ${varName} from inline code`);
  }
  const literals = stringLiterals(text);
  const writes =
    /writeFile|appendFile|createWriteStream|unlink|rmSync|\brm\s*\(|rmdir|rename|copyFile|cpSync|truncate|\bopen\s*\([^)]*['"][wax+]|write_text|write_bytes|shutil\.|os\.remove|chmod|symlink|Set-Content|Out-File|WriteAll(Text|Bytes|Lines)|AppendAll(Text|Lines)|::(Delete|Move|Copy|Replace|Create)\s*\(/.test(
      text,
    );
  for (const literal of literals) {
    // Paths have no whitespace; prose like '.env.local is gitignored' is not a path.
    if (/[\\/.]/.test(literal) && !/\s/.test(literal) && literal.length < 300) {
      const abs = resolveArgPath(literal, state.cwd);
      if (isSecretPath(abs)) ctx.deny(`inline code references a secret file (${literal})`);
      if (writes) checkConfigWrite(abs, literal, ctx, state);
    }
    if (/\s/.test(literal)) inspectScript(literal, "bash", ctx, depth + 1, { ...state });
  }
}

// Expands shell globs/braces in a path argument against the file system, so `cat .e*`
// or `cat {.env.local,x}` is checked against the files it would actually match.
function expandPattern(candidate, cwd) {
  const braces = /\{([^{}]*,[^{}]*)\}/.exec(candidate);
  if (braces) {
    return braces[1]
      .split(",")
      .flatMap((part) => expandPattern(candidate.replace(braces[0], part), cwd));
  }
  if (!/[*?[]/.test(candidate)) return [candidate];
  const normalized = candidate.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dir = slash === -1 ? "." : normalized.slice(0, slash) || "/";
  const pattern = normalized.slice(slash + 1);
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) source += "\\[";
      else {
        source += `[${pattern
          .slice(i + 1, close)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else source += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try {
    const regex = new RegExp(`${source}$`, "i");
    const entries = fs.readdirSync(path.resolve(cwd, dir));
    const matches = entries.filter((entry) => regex.test(entry));
    return [candidate, ...matches.map((m) => (slash === -1 ? m : `${dir}/${m}`))];
  } catch {
    return [candidate];
  }
}

const RECURSIVE_SEARCH = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "findstr"]);

// Recursive searches print matching lines from every file they visit. .env* files are
// gitignored, but grep (unlike `git grep` or default `rg`) does not honour .gitignore.
function inspectRecursiveSearch(name, args, ctx, state) {
  if (!RECURSIVE_SEARCH.has(name)) return;
  const lower = args.map((a) => a.toLowerCase());
  let recursive;
  if (name === "rg" || name === "ag") {
    recursive = lower.some(
      (a) =>
        a === "--no-ignore" ||
        a === "--hidden" ||
        a === "-." ||
        /^-u+$/.test(a) ||
        a === "--unrestricted",
    );
  } else if (name === "findstr") {
    recursive = lower.some((a) => a === "/s");
  } else {
    recursive = args.some(
      (a) =>
        a === "--recursive" ||
        a === "--dereference-recursive" ||
        (/^-[a-zA-Z]+$/.test(a) && /[rR]/.test(a)),
    );
  }
  if (!recursive) return;
  if (args.some((a) => /^--exclude=['"]?\.env/i.test(a) || /^--glob=['"]?!\.env/i.test(a))) return;
  const valueFlags = [
    "-e",
    "-f",
    "--regexp",
    "--file",
    "-m",
    "--max-count",
    "-A",
    "-B",
    "-C",
    "-g",
    "--glob",
    "--include",
    "--exclude",
  ];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.includes(args[i])) i++;
    else if (!isFlag(args[i])) positional.push(args[i]);
  }
  const hasPatternFlag = args.some((a) => ["-e", "-f", "--regexp", "--file"].includes(a));
  const targets = hasPatternFlag ? positional : positional.slice(1);
  if (!targets.length) targets.push(".");
  for (const target of targets) {
    try {
      const dir = path.resolve(state.cwd, target.replace(/\\/g, "/"));
      if (!fs.statSync(dir).isDirectory()) continue;
      const secret = fs.readdirSync(dir).find((entry) => isSecretEnvFileName(entry));
      if (secret) {
        ctx.deny(
          `searches ${target} recursively, which would print values from ${secret}; exclude it (for example --exclude='.env*') or use git grep`,
        );
      }
    } catch {
      // nonexistent target: nothing to leak
    }
  }
}

function isSecretEnvFileName(entry) {
  return /^\.env(\.[^\s]+)?$/i.test(entry) && !/\.(example|sample|template)$/i.test(entry);
}

function inspectFind(name, args, ctx, state, depth) {
  if (name !== "find") return;
  const execIndex = args.findIndex((a) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a));
  const names = args.filter((a, i) => /^-(i?name|i?path|i?regex)$/.test(args[i - 1] ?? ""));
  if (execIndex !== -1 || args.includes("-delete") || args.includes("-fprint")) {
    if (names.some((n) => /\.env|credential|\.pem|id_[a-z0-9]+|hosts\.ya?ml|netrc/i.test(n))) {
      ctx.deny("runs a command on secret files selected by find");
    }
  }
  if (execIndex !== -1) {
    const end = args.findIndex((a, i) => i > execIndex && (a === ";" || a === "+" || a === "\\;"));
    const execWords = args.slice(execIndex + 1, end === -1 ? undefined : end);
    inspectScript(execWords.join(" "), "bash", ctx, depth + 1, { ...state });
  }
}

function inspectFileArguments(name, args, ctx, state) {
  const candidates = [];
  let destination = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-(destination|target-directory)$/i.test(a) || a === "-t") {
      destination = args[i + 1] ?? null;
      continue;
    }
    // Include/exclude patterns are filters, not files being read.
    if (/^--(exclude|exclude-dir|include|glob|iglob)=/.test(a)) continue;
    if (["--exclude", "--exclude-dir", "--include", "--glob", "--iglob", "-g"].includes(a)) {
      i++;
      continue;
    }
    if (a === "--env-file" || /^--env-file=/.test(a)) {
      if (a === "--env-file") i++;
      continue;
    }
    if (a.includes("=")) candidates.push(a.slice(a.indexOf("=") + 1));
    if (!isFlag(a)) candidates.push(a.replace(/^@/, ""));
  }
  const positional = args.filter((a) => !isFlag(a));
  if (COPY_COMMANDS.has(name) && destination === null)
    destination = positional[positional.length - 1] ?? null;

  const inPlace =
    ["sed", "perl", "ruby"].includes(name) &&
    args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
  const isGit = name === "git";
  const gitSub = isGit ? args.find((a) => !isFlag(a)) : null;

  for (const original of candidates) {
    for (const candidate of expandPattern(original, state.cwd)) {
      const abs = resolveArgPath(candidate, state.cwd);
      if (!abs) continue;
      if (isSecretPath(abs)) {
        if (METADATA_COMMANDS.has(name)) {
          // listing or testing for existence never prints contents
        } else if (DELETE_COMMANDS.has(name)) {
          ctx.ask(`deletes a secret file (${candidate})`);
        } else if (isGit) {
          if (["diff", "show", "blame", "cat-file", "grep", "log"].includes(gitSub)) {
            ctx.deny(`prints the contents of a secret file (${candidate})`);
          }
        } else if (!(
          name === "dd" && candidate === args.find((a) => a.startsWith("of="))?.slice(3)
        )) {
          ctx.deny(`reads, copies or writes a secret file (${candidate})`);
        }
      }
      const isWrite =
        DELETE_COMMANDS.has(name) ||
        MOVE_COMMANDS.has(name) ||
        WRITE_COMMANDS.has(name) ||
        inPlace ||
        (COPY_COMMANDS.has(name) && original === destination) ||
        (name === "dd" && args.some((a) => a === `of=${original}`));
      if (isWrite) {
        checkConfigWrite(abs, candidate, ctx, state);
        if (/(^|\/)package\.json$/.test(abs)) {
          ctx.ask("modifies package.json from the shell, bypassing the validation-script check");
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MCP tools

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

const READ_ONLY_SQL = /^\s*(select|with|explain|show|values|table|describe)\b/i;
const WRITE_SQL =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|do|comment|lock|refresh|reindex|cluster|merge|set\s+(role|session))\b/i;
const SENSITIVE_SQL =
  /\b(auth|vault|storage|supabase_functions|pgsodium)\s*\.|\bpg_shadow\b|\bpg_authid\b/i;

function isReadOnlySql(sql) {
  const statements = String(sql)
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    statements.length > 0 && statements.every((s) => READ_ONLY_SQL.test(s) && !WRITE_SQL.test(s))
  );
}

const MCP_WRITE_TOOL =
  /(^|_)(write|edit|create|move|rename|delete|remove|append|patch|replace)(_|$)/;
const MCP_PATH_KEYS = [
  "path",
  "file_path",
  "filepath",
  "filename",
  "destination",
  "target",
  "source",
  "paths",
];

function inspectMcp(toolName, input, ctx) {
  const tool = toolName.split("__").slice(2).join("__").toLowerCase();
  const serialized = JSON.stringify(input ?? {});
  for (const value of collectStrings(input)) {
    if (
      value.length > 500 ||
      !/\.env|\.claude|credential|\.ssh|\.netrc|hosts\.yml|\.pem|environ/i.test(value)
    )
      continue;
    const abs = resolveArgPath(value.replace(/^file:\/\/\/?/i, ""), ctx.cwd);
    if (isSecretPath(abs)) ctx.deny(`passes a secret file path (${value}) to an MCP tool`);
  }
  // File-system style MCP servers get the same protected-config rules as Edit/Write.
  if (MCP_WRITE_TOOL.test(tool)) {
    for (const key of MCP_PATH_KEYS) {
      for (const p of collectStrings(input?.[key])) {
        const abs = resolveArgPath(p.replace(/^file:\/\/\/?/i, ""), ctx.cwd);
        checkConfigWrite(abs, p, ctx, { cwd: ctx.cwd });
      }
    }
  }
  if (/deploy|promote|alias/.test(tool) && /production|\bprod\b/i.test(serialized)) {
    ctx.deny(
      `MCP tool ${toolName} targets production; production releases go through the release workflow`,
    );
  }
  if (
    /(^|_)(merge|delete|remove|destroy|drop|deploy|promote|rollback|dispatch|rerun|cancel|approve|revoke|rotate|transfer|archive|reset|restore|pause)(_|$)/.test(
      tool,
    ) ||
    /apply_migration|run_workflow|workflow_dispatch|push_files|create_or_update_file|update_pull_request_branch|update_ref|branch_protection|ruleset|secret|environment_variable|api_key/.test(
      tool,
    )
  ) {
    ctx.ask(`MCP tool ${toolName} performs a protected or destructive action`);
  }
  if (/review/.test(tool) && /APPROVE/.test(serialized))
    ctx.ask(`MCP tool ${toolName} approves a pull request`);
  if (/(^|_)(execute_sql|run_sql|sql|query)($|_)/.test(tool)) {
    const sql = input?.query ?? input?.sql ?? input?.statement ?? "";
    if (!isReadOnlySql(sql)) ctx.ask(`MCP tool ${toolName} runs SQL that is not read-only`);
    else if (SENSITIVE_SQL.test(sql))
      ctx.ask(`MCP tool ${toolName} reads auth, vault or storage internals`);
  }
}

// ---------------------------------------------------------------------------

runGuard("command-guard", (payload) => {
  const ctx = makeContext(payload);
  const tool = String(payload.tool_name ?? "");
  const input = payload.tool_input ?? {};
  if (tool.startsWith("mcp__")) {
    inspectMcp(tool, input, ctx);
  } else if (input.command !== undefined) {
    // Bash, PowerShell, Monitor, and any future tool that runs a shell command.
    if (typeof input.command !== "string") {
      ctx.deny("the shell command is malformed, so it could not be inspected");
    } else {
      inspectScript(input.command, tool === "PowerShell" ? "powershell" : "bash", ctx, 0);
    }
  }
  return ctx.verdict;
});
