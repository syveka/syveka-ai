// Shared path classification for the SYVEKA guardrail hooks (CLAUDE.md §9).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Repository-relative (posix, lower-cased) paths whose modification requires explicit
// human authorization: verification/CI policy, agent configuration, and secrets.
const PROTECTED_CONFIG = [
  /(^|\/)claude\.md$/,
  /^\.claude(\/|$)/,
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)eslint\.config\.(mjs|js|cjs|ts)$/,
  /(^|\/)\.eslintrc(\..*)?$/,
  /(^|\/)\.prettierrc(\..*)?$/,
  /(^|\/)prettier\.config\.(mjs|js|cjs)$/,
  /(^|\/)\.prettierignore$/,
  /^tsconfig(\.[\w-]+)?\.json$/,
  /^vitest\.(config|workspace)\.(mjs|js|cjs|ts|mts|cts)$/,
  /^playwright\.config\.(mjs|js|cjs|ts|mts|cts)$/,
  /^\.github(\/|$)/,
  /^vercel\.json$/,
  /^\.npmrc$/,
  /^\.husky(\/|$)/,
  /^lefthook(-local)?\.ya?ml$/,
  /^scripts\/ci(\/|$)/,
  /^tests(\/unit)?$/,
  /^scripts\/(check-i18n-parity|check-migration-history|verify-release-chain|validate-staging-config|verify-prisma-engine|generate-legacy-schema-contract|check-dashboard-index-ownership|run-npm-audit)\.(mjs|ts|js)$/,
  /^tests\/unit\/hook-[\w-]+\.test\.ts$/,
  /^\.mcp\.json$/,
  // Git's own config and hooks can re-enable every bypass the command guard blocks.
  /(^|\/)\.git\/(.*\/)?(config(\.worktree)?|hooks(\/.*)?|info\/attributes)$/,
];

// Template env files carry no secrets and are edited whenever a variable is added.
const ENV_TEMPLATE = /^\.env(\..+)?\.(example|sample|template)(\.[^\s]+)?$/;

// Worktrees nested inside the checkout are separate working copies; evaluate the
// path relative to the worktree root instead of treating it all as `.claude/**`.
const NESTED_WORKTREE = /^(?:\.claude\/worktrees|\.worktrees)\/[^/]+\//;

// Credential stores outside the repository (absolute, posix, lower-cased suffixes).
const CREDENTIAL_PATHS = [
  /\/\.claude\/\.credentials\.json$/,
  /\/\.claude\.json(\.backup(\.\d+)?)?$/,
  /\/\.claude\/backups\/.*claude\.json/,
  /\/\.config\/gh\/hosts\.ya?ml$/,
  /\/github cli\/hosts\.ya?ml$/,
  /\/\.git-credentials$/,
  /\/[._]netrc$/,
  /\/\.npmrc$/,
  /\/\.pgpass$/,
  /\/pgpass\.conf$/,
  /\/\.aws\/credentials$/,
  /\/\.docker\/config\.json$/,
  /\/com\.vercel\.cli\/.*auth\.json$/,
  /\/\.vercel\/auth\.json$/,
  /\/\.supabase\/access-token$/,
  /\/\.ssh\/(?!.*\.pub$)(?!known_hosts)(?!config$)[^/]+$/,
  /\.pem$/,
  /\/proc\/[^/]+\/environ$/,
];

// Agent configuration anywhere (user-level ~/.claude, other checkouts): editing it can grant
// the agent new permissions, hooks, skills or instructions.
const AGENT_CONFIG_ANYWHERE = [
  /\/\.claude\/settings(\.local)?\.json$/,
  /\/\.claude\/(hooks|skills|agents|commands|plugins|rules|output-styles)(\/|$)/,
  /\/\.claude\.json$/,
  /\/claude\.md$/,
  /\/\.github\/workflows\//,
  /\/\.mcp\.json$/,
  /\/\.gitconfig$/,
  /\/\.config\/git\/(config|attributes)$/,
  /\/\.git\/(.*\/)?(config(\.worktree)?|hooks\/.*|info\/attributes)$/,
];

function toPosix(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  // Git Bash style /c/Users/... -> c:/Users/...
  const msys = /^\/([a-z])\/(.*)$/i.exec(s);
  if (msys) s = `${msys[1]}:/${msys[2]}`;
  return s;
}

export function toPosixLower(p) {
  return toPosix(p).toLowerCase();
}

// Expands Windows 8.3 short names (CLAUDE~1) and symlinks by resolving the deepest
// existing ancestor, so aliases of a protected path can't slip past the rules.
function canonicalize(absPosix) {
  let existing = absPosix;
  const missing = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = toPosix(fs.realpathSync.native(existing));
      return path.posix.join(real, ...missing.reverse());
    } catch {
      const parent = path.posix.dirname(existing);
      if (parent === existing) break;
      missing.push(path.posix.basename(existing));
      existing = parent;
    }
  }
  return absPosix;
}

const resolveCache = new Map();

/** Resolves a shell/tool path argument to an absolute, canonical, posix, lower-cased path. */
export function resolveArgPath(arg, cwd) {
  const key = `${cwd}\u0000${arg}`;
  if (resolveCache.has(key)) return resolveCache.get(key);
  const resolved = resolveArgPathUncached(arg, cwd);
  resolveCache.set(key, resolved);
  return resolved;
}

function resolveArgPathUncached(arg, cwd) {
  let raw = String(arg ?? "").trim();
  if (!raw) return null;
  const home = os.homedir();
  raw = raw
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/^\$HOME(?=$|[\\/])/i, home)
    .replace(/^\$\{HOME\}(?=$|[\\/])/i, home)
    .replace(/^\$env:(USERPROFILE|HOME)(?=$|[\\/])/i, home)
    .replace(/^%USERPROFILE%(?=$|[\\/])/i, home)
    .replace(/^\\\\\?\\/, "")
    .replace(/^\/\/\?\//, "");
  let posix = toPosix(raw);
  // NTFS alternate data streams (file::$DATA, file:stream) address the same file.
  const drive = /^[a-z]:/i.test(posix) ? posix.slice(0, 2) : "";
  const rest = posix.slice(drive.length);
  if (rest.includes(":")) posix = drive + rest.slice(0, rest.indexOf(":"));
  const isAbsolute = /^[a-z]:\//i.test(posix) || posix.startsWith("/");
  const abs = isAbsolute ? posix : path.posix.join(toPosix(cwd || process.cwd()), posix);
  // Windows ignores trailing dots and spaces in path components (`CLAUDE.md.` is
  // CLAUDE.md), so strip them before matching.
  const trimmed = path.posix
    .normalize(abs)
    .split("/")
    .map((part) => (part === "." || part === ".." ? part : part.replace(/[. ]+$/, "") || part))
    .join("/");
  return canonicalize(trimmed).toLowerCase();
}

const mainCheckoutCache = new Map();

// The primary checkout that owns `dir`'s repository (differs from `dir` inside a worktree).
function mainCheckoutRoot(dir) {
  if (!dir) return null;
  if (mainCheckoutCache.has(dir)) return mainCheckoutCache.get(dir);
  let root = null;
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 },
    ).trim();
    if (/[\\/]\.git$/.test(commonDir)) root = path.dirname(commonDir);
  } catch {
    root = null;
  }
  mainCheckoutCache.set(dir, root);
  return root;
}

function relativeWithin(root, abs) {
  if (!root) return null;
  const base = toPosixLower(root).replace(/\/+$/, "");
  if (abs === base) return "";
  if (!abs.startsWith(`${base}/`)) return null;
  return abs.slice(base.length + 1);
}

function stripNestedWorktrees(rel) {
  let current = rel;
  while (NESTED_WORKTREE.test(current)) current = current.replace(NESTED_WORKTREE, "");
  return current;
}

function basename(abs) {
  return abs.split("/").pop() ?? "";
}

export function isSecretEnvFile(abs) {
  const name = basename(abs);
  return /^\.env(\.[^\s]+)?$|^\.env\*/.test(name) && !ENV_TEMPLATE.test(name);
}

/** True when reading the file would expose secrets or credentials. */
export function isSecretPath(abs) {
  if (!abs) return false;
  return isSecretEnvFile(abs) || CREDENTIAL_PATHS.some((re) => re.test(abs));
}

/**
 * Returns a human-readable label when writing `abs` needs explicit authorization,
 * otherwise null. `roots` are candidate repository roots (project dir, cwd).
 */
export function protectedConfigLabel(abs, roots) {
  if (!abs) return null;
  if (ENV_TEMPLATE.test(basename(abs))) return null;
  const candidates = roots.filter(Boolean).map((r) => canonicalize(toPosix(path.resolve(r))));
  const check = (list) => {
    for (const root of list) {
      const rel = relativeWithin(root, abs);
      if (rel === null || rel === "") continue;
      const inner = stripNestedWorktrees(rel);
      if (PROTECTED_CONFIG.some((re) => re.test(inner))) return inner;
    }
    return null;
  };
  const label = check(candidates);
  if (label) return label;
  if (AGENT_CONFIG_ANYWHERE.some((re) => re.test(abs))) return abs;
  if (isSecretEnvFile(abs)) return abs;
  // From a worktree session, the primary checkout's config is protected too. Only paths
  // outside the session's own roots need the (git-spawning) lookup.
  if (candidates.some((root) => relativeWithin(root, abs) !== null)) return null;
  const mains = [...new Set(roots.filter(Boolean).map(mainCheckoutRoot).filter(Boolean))];
  return check(mains.map((r) => canonicalize(toPosix(r))));
}

/** Shell-style glob match on a single path component (*, ?, [...], {a,b}). */
export function globMatches(name, pattern) {
  const braces = /\{([^{}]*)\}/.exec(pattern);
  if (braces) {
    return braces[1].split(",").some((part) => globMatches(name, pattern.replace(braces[0], part)));
  }
  const base = String(pattern).replace(/\\/g, "/").split("/").pop() ?? "";
  let source = "^";
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[" && base.indexOf("]", i + 1) !== -1) {
      const close = base.indexOf("]", i + 1);
      source += `[${base
        .slice(i + 1, close)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\")}]`;
      i = close;
    } else source += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try {
    return new RegExp(`${source}$`, "i").test(name);
  } catch {
    return false;
  }
}

export function isOverrideEnabled() {
  return process.env.SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT === "1";
}
