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

describe("every API route handler is guarded", () => {
  it("finds the routes", () => {
    expect(routeFiles.length).toBeGreaterThan(50);
  });

  it.each(routeFiles)("%s", (file) => {
    const source = read(file);
    const guarded = has(source, SESSION_GUARDS) || has(source, SIGNATURE_GUARDS);
    const declared = PUBLIC_ROUTES[file];
    if (declared) {
      expect(guarded, `${file} is declared public but has a guard: remove it from the list`).toBe(
        false,
      );
      if (declared.rateLimited) {
        expect(has(source, RATE_LIMITS), `${file}: a public route must be rate limited`).toBe(true);
      }
      return;
    }
    expect(
      guarded,
      `${file}: no session guard or signature verification found. Add one, or declare it public (with a rate limit) in this test.`,
    ).toBe(true);
  });

  it("declares only routes that exist", () => {
    expect(Object.keys(PUBLIC_ROUTES).filter((f) => !routeFiles.includes(f))).toEqual([]);
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
