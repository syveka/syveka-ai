import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every API route handler and every exported Server Action enforces its own
 * authentication (middleware.ts is not a security boundary; see
 * docs/DEVELOPMENT.md §4). This test reads the source of each one and checks
 * for the call that does it, so a new handler can't be merged without one:
 *
 * - a session guard (requirePermission / getTenantContext / requireSuperadmin),
 * - or a signature/secret verification (QStash, Stripe, Vapi, svix, a
 *   shared secret, a per-subscription webhook secret, a signed OAuth state),
 * - or an explicit entry below naming why the handler is public, and then a
 *   rate limit (an uptime probe and the Supabase auth callback excepted).
 *
 * It is a static check: it proves the call is present in the file (routes)
 * or in the function body (actions), not that every branch reaches it. The
 * behavior of each guard has its own tests (*-rbac, rate-limit-*, webhook
 * and job suites).
 */

const root = path.join(__dirname, "../../../src");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const SESSION_GUARDS = [
  "requirePermission(",
  "getTenantContext(",
  "getTenantContextOrNull(",
  "requireSuperadmin(",
];

const SIGNATURE_GUARDS = [
  "verifyJobRequest(", // QStash jobs
  "constructEvent(", // Stripe
  "verifyVapiSignature(", // Vapi HMAC
  "verifyResendWebhookSignature(", // svix
  "timingSafeEqual(", // shared-secret webhook
  "handleProviderWebhook(", // per-subscription calendar webhook secret
  "verifyOAuthState(", // signed OAuth state (+ session, checked above)
];

const RATE_LIMITS = [
  "rateLimitRefusal(",
  "checkRateLimit(",
  "actionRateLimitError(",
  "actionWriteLimitError(",
];

/** Routes with no session or signature: each must say why, and be rate limited. */
const PUBLIC_ROUTES: Record<string, { why: string; rateLimited: boolean }> = {
  "app/api/health/route.ts": { why: "uptime probe, reports no tenant data", rateLimited: false },
  "app/api/auth/callback/route.ts": {
    why: "Supabase auth code exchange; the code is the credential, next= is checked",
    rateLimited: false,
  },
  "app/api/v1/booking/[org]/[slug]/route.ts": {
    why: "public booking page (org slug + published booking type)",
    rateLimited: true,
  },
  "app/api/v1/booking/[org]/[slug]/slots/route.ts": {
    why: "public booking slots",
    rateLimited: true,
  },
  "app/api/v1/booking/manage/[token]/route.ts": {
    why: "guest manage link; the hashed single-use token is the credential",
    rateLimited: true,
  },
  "app/api/v1/public-assistant/route.ts": {
    why: "marketing-site demo assistant",
    rateLimited: true,
  },
};

/** Actions with no session guard: each must say why, and what it has instead. */
const PUBLIC_ACTIONS: Record<string, { why: string; mustContain: string }> = {
  "actions/auth.ts#loginAction": { why: "sign-in", mustContain: "actionRateLimitError(" },
  "actions/auth.ts#registerAction": { why: "sign-up", mustContain: "actionRateLimitError(" },
  "actions/auth.ts#magicLinkAction": { why: "magic link", mustContain: "actionRateLimitError(" },
  "actions/auth.ts#forgotPasswordAction": {
    why: "password reset email",
    mustContain: "actionRateLimitError(",
  },
  "actions/auth.ts#logoutAction": { why: "ends own session", mustContain: "supabase.auth." },
  "actions/auth.ts#signOutToInvitationAction": {
    why: "ends own session",
    mustContain: "supabase.auth.",
  },
  "actions/auth.ts#resetPasswordAction": {
    why: "needs the recovery session Supabase itself established",
    mustContain: "supabase.auth.updateUser(",
  },
  "actions/admin-entitlement-grants.ts#createEntitlementGrantAction": {
    why: "requireSuperadmin() runs inside the service (asserted below)",
    mustContain: "grantEntitlementOverride(",
  },
  "actions/admin-entitlement-grants.ts#revokeEntitlementGrantAction": {
    why: "requireSuperadmin() runs inside the service (asserted below)",
    mustContain: "revokeEntitlementOverride(",
  },
};

function walk(dir: string, match: (file: string) => boolean): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, match);
    return match(entry.name) ? [path.relative(root, full)] : [];
  });
}

const has = (source: string, markers: string[]) => markers.some((m) => source.includes(m));

const routeFiles = walk(path.join(root, "app/api"), (f) => f === "route.ts").sort();
const actionFiles = walk(path.join(root, "actions"), (f) => f.endsWith(".ts")).sort();

/** Exported async functions of an action module: name and body. */
function exportedActions(source: string): Array<{ name: string; body: string }> {
  return source
    .split(/^export async function /m)
    .slice(1)
    .map((body) => ({ name: body.slice(0, body.indexOf("(")), body }));
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Exported route handlers of a route module: method and body (one per export). */
function exportedHandlers(source: string): Array<{ method: string; body: string }> {
  const parts = source.split(/^export async function /m).slice(1);
  return parts
    .map((body) => ({ method: body.slice(0, body.indexOf("(")), body }))
    .filter(({ method }) => HTTP_METHODS.includes(method));
}

/**
 * Names of the module's own (non-exported) functions whose body carries one of
 * the markers: a handler may delegate its guard to such a helper (`guard()`,
 * `secretMatches()`), and then counts as guarded when it calls it.
 */
function guardingHelpers(source: string, markers: string[]): string[] {
  const names: string[] = [];
  const declaration = /^(?:async )?function (\w+)\s*\(/gm;
  for (const match of source.matchAll(declaration)) {
    const name = match[1]!;
    const start = match.index!;
    const next = source.slice(start + 1).search(/^(?:export )?(?:async )?function /m);
    const body = next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
    if (has(body, markers)) names.push(name);
  }
  return names;
}

const guardedBy = (body: string, markers: string[], helpers: string[]) =>
  has(body, markers) || helpers.some((name) => body.includes(`${name}(`));

/**
 * Exports the scans above read: `export async function NAME` at column 0, and
 * for a route its segment config. Any other export shape (a const arrow, a
 * re-export, a default export, a wrapped handler) would hide a handler or an
 * action from them, so it is refused instead of silently passing.
 */
function unexpectedExports(source: string, allowed: RegExp): string[] {
  return source
    .split("\n")
    .filter((line) => /^export\b/.test(line))
    .filter((line) => !/^export async function \w+\(/.test(line))
    .filter((line) => !/^export (type|interface) /.test(line))
    .filter((line) => !allowed.test(line));
}

const ROUTE_SEGMENT_CONFIG = /^export const (runtime|dynamic|maxDuration|revalidate) = /;

describe("every API route handler is guarded", () => {
  it("finds the routes", () => {
    expect(routeFiles.length).toBeGreaterThan(50);
  });

  it.each(routeFiles)("%s", (file) => {
    const source = read(file);
    const handlers = exportedHandlers(source);
    expect(handlers.length, `${file}: no exported handler found`).toBeGreaterThan(0);
    const sessionHelpers = guardingHelpers(source, SESSION_GUARDS);
    const signatureHelpers = guardingHelpers(source, SIGNATURE_GUARDS);
    const declared = PUBLIC_ROUTES[file];
    for (const { method, body } of handlers) {
      const guarded =
        guardedBy(body, SESSION_GUARDS, sessionHelpers) ||
        guardedBy(body, SIGNATURE_GUARDS, signatureHelpers);
      if (declared) {
        expect(
          guarded,
          `${file} ${method} is declared public but has a guard: remove it from the list`,
        ).toBe(false);
        if (declared.rateLimited) {
          expect(
            has(body, RATE_LIMITS),
            `${file} ${method}: a public route must be rate limited`,
          ).toBe(true);
        }
        continue;
      }
      expect(
        guarded,
        `${file} ${method}: no session guard or signature verification in this handler (or a helper it calls). Add one, or declare the route public (with a rate limit) in this test.`,
      ).toBe(true);
    }
  });

  it("declares only routes that exist", () => {
    expect(Object.keys(PUBLIC_ROUTES).filter((f) => !routeFiles.includes(f))).toEqual([]);
  });

  it("exports handlers only as `export async function METHOD` (plus segment config), so none can hide", () => {
    for (const file of routeFiles) {
      expect(
        unexpectedExports(read(file), ROUTE_SEGMENT_CONFIG),
        `${file}: handlers must be \`export async function\``,
      ).toEqual([]);
    }
  });

  it("every file under src/app/api is a route module (no helper modules with hidden handlers)", () => {
    const others = walk(path.join(root, "app/api"), (f) => f.endsWith(".ts") && f !== "route.ts");
    expect(others).toEqual([]);
  });
});
describe("every exported Server Action is guarded", () => {
  it("finds the actions", () => {
    expect(actionFiles.length).toBeGreaterThan(15);
  });

  it.each(actionFiles)("%s", (file) => {
    const actions = exportedActions(read(file));
    expect(actions.length, `${file}: no exported actions found`).toBeGreaterThan(0);
    for (const { name, body } of actions) {
      const declared = PUBLIC_ACTIONS[`${file}#${name}`];
      if (declared) {
        expect(body.includes(declared.mustContain), `${file}#${name}: ${declared.why}`).toBe(true);
        continue;
      }
      expect(
        has(body, [...SESSION_GUARDS, "getSessionUser("]),
        `${file}#${name}: no session guard found. Add one, or declare it in this test with why.`,
      ).toBe(true);
    }
  });

  it("exports actions only as `export async function`, and only under src/actions", () => {
    for (const file of actionFiles) {
      expect(
        unexpectedExports(read(file), /^$/),
        `${file}: actions must be \`export async function\``,
      ).toEqual([]);
    }
    const outside = walk(root, (f) => f.endsWith(".ts") || f.endsWith(".tsx")).filter(
      (f) => !f.startsWith("actions/") && /^"use server";?\s*$/m.test(read(f)),
    );
    expect(outside, "server action modules live under src/actions so this test sees them").toEqual(
      [],
    );
  });

  it("declares only actions that exist", () => {
    const existing = new Set(
      actionFiles.flatMap((file) => exportedActions(read(file)).map((a) => `${file}#${a.name}`)),
    );
    expect(Object.keys(PUBLIC_ACTIONS).filter((k) => !existing.has(k))).toEqual([]);
  });

  it("the entitlement-grant service enforces requireSuperadmin for both actions", () => {
    const service = read("server/services/billing/entitlement-grants.ts");
    for (const fn of ["grantEntitlementOverride", "revokeEntitlementOverride"]) {
      const body = service.slice(service.indexOf(`export async function ${fn}(`));
      expect(body.indexOf("requireSuperadmin("), fn).toBeGreaterThan(0);
    }
  });
});
