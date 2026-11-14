import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type * as CalendarConnections from "@/server/services/calendar-connections";

/**
 * Fail-closed coverage around the OAuth callbacks' session binding (#264):
 *  - the calendar state really is signed and time-limited (the Meta state has the same
 *    coverage in social-oauth-state.test.ts);
 *  - every failure before or during completion redirects with a fixed error code only,
 *    never completes the connection, and never echoes internal error text.
 * Synthetic data only.
 */
const m = vi.hoisted(() => ({
  session: vi.fn(),
  completeConnection: vi.fn(async () => ({ orgId: "org-a", connectionId: "c1" })),
  completeMetaOAuthCallback: vi.fn(async () => ({ orgId: "org-a", accountId: "a1" })),
}));

vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: {}, tenantDb: vi.fn() }));
vi.mock("@/server/integrations/calendar", () => ({ getProviderAdapter: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getTenantContextOrNull: m.session }));
vi.mock("@/server/services/calendar-connections", async (importOriginal) => {
  const actual = await importOriginal<typeof CalendarConnections>();
  // Real state signing/verification; only the token exchange is replaced.
  return { ...actual, completeConnection: m.completeConnection };
});
vi.mock("@/server/services/creator-social-accounts", () => ({
  SocialConnectError: class extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
  completeMetaOAuthCallback: m.completeMetaOAuthCallback,
}));

import {
  buildOAuthState,
  ConnectionError,
  verifyOAuthState,
} from "@/server/services/calendar-connections";
import { buildSocialOAuthState } from "@/server/social/oauth-state";
import { GET as calendarCallback } from "@/app/api/v1/integrations/calendar/[provider]/callback/route";
import { GET as metaCallback } from "@/app/api/v1/creator-studio/social-accounts/oauth/meta/callback/route";

const SECRET = "synthetic-state-secret-for-tests-only";
const ctx = { orgId: "org-a", userId: "user-a" } as Parameters<typeof buildOAuthState>[0];

const calendar = (query: string, provider = "google") =>
  calendarCallback(
    new Request(`https://app.example/api/v1/integrations/calendar/${provider}/callback?${query}`),
    { params: Promise.resolve({ provider }) },
  );
const meta = (query: string) =>
  metaCallback(
    new Request(
      `https://app.example/api/v1/creator-studio/social-accounts/oauth/meta/callback?${query}`,
    ),
  );
const errorParam = (res: Response, name: string) =>
  new URL(res.headers.get("location")!).searchParams.get(name);

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of [
    "CALENDAR_OAUTH_STATE_SECRET",
    "META_OAUTH_STATE_SECRET",
    "QSTASH_CURRENT_SIGNING_KEY",
  ]) {
    saved[k] = process.env[k];
  }
  process.env.CALENDAR_OAUTH_STATE_SECRET = SECRET;
  process.env.META_OAUTH_STATE_SECRET = SECRET;
});
afterEach(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("calendar OAuth state is signed and time-limited", () => {
  it("rejects a state whose signature was changed", () => {
    const [encoded] = buildOAuthState(ctx, "GOOGLE").split(".");
    expect(() => verifyOAuthState(`${encoded}.AAAA`)).toThrow(ConnectionError);
  });

  it("rejects a payload re-signed with another secret (another user or org)", () => {
    const payload = `org-victim.user-a.GOOGLE.${Date.now()}.00`;
    const sig = createHmac("sha256", "another-secret").update(payload).digest("base64url");
    expect(() => verifyOAuthState(`${Buffer.from(payload).toString("base64url")}.${sig}`)).toThrow(
      ConnectionError,
    );
  });

  it("rejects a state older than 10 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T10:00:00Z"));
    const state = buildOAuthState(ctx, "GOOGLE");
    vi.setSystemTime(new Date("2026-11-15T10:10:01Z"));
    expect(() => verifyOAuthState(state)).toThrow(/expired/i);
  });

  it("rejects a malformed state", () => {
    for (const bad of ["", "no-dot", ".", "abc."]) {
      expect(() => verifyOAuthState(bad)).toThrow(ConnectionError);
    }
  });
});

describe("OAuth callbacks fail closed", () => {
  it("calendar: an expired state is refused before any completion, even for the right user", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T10:00:00Z"));
    const state = buildOAuthState(ctx, "GOOGLE");
    vi.setSystemTime(new Date("2026-11-15T10:10:01Z"));
    m.session.mockResolvedValueOnce({ userId: "user-a", orgId: "org-a" });

    const res = await calendar(`code=c&state=${encodeURIComponent(state)}`);

    expect(errorParam(res, "calendar_error")).toBe("bad_state");
    expect(m.completeConnection).not.toHaveBeenCalled();
  });

  it("calendar: a real state for another user is refused for the signed-in user", async () => {
    const state = buildOAuthState({ ...ctx, userId: "attacker" } as typeof ctx, "GOOGLE");
    m.session.mockResolvedValueOnce({ userId: "user-a", orgId: "org-a" });

    const res = await calendar(`code=c&state=${encodeURIComponent(state)}`);

    expect(errorParam(res, "calendar_error")).toBe("session_mismatch");
    expect(m.completeConnection).not.toHaveBeenCalled();
  });

  it("calendar: an unknown provider is refused without touching the session", async () => {
    const res = await calendar("code=c&state=s", "evil");
    expect(res.status).toBe(404);
    expect(m.session).not.toHaveBeenCalled();
  });

  it.each([["code=c"], ["state=s"], [""]])(
    "calendar and meta: missing code or state (%s) is refused before the session lookup",
    async (query) => {
      expect(errorParam(await calendar(query), "calendar_error")).toBe("missing_code");
      expect(errorParam(await meta(query), "social_error")).toBe("missing_code");
      expect(m.session).not.toHaveBeenCalled();
    },
  );

  it("meta: a provider error is reported as authorization_denied without completion", async () => {
    const res = await meta("error=access_denied&code=c&state=s");
    expect(errorParam(res, "social_error")).toBe("authorization_denied");
    expect(m.completeMetaOAuthCallback).not.toHaveBeenCalled();
  });

  it("meta: a real state for another user is refused for the signed-in user", async () => {
    const state = buildSocialOAuthState("org-a", "attacker", "FACEBOOK");
    m.session.mockResolvedValueOnce({ userId: "user-a", orgId: "org-a" });

    const res = await meta(`code=c&state=${encodeURIComponent(state)}`);

    expect(errorParam(res, "social_error")).toBe("session_mismatch");
    expect(m.completeMetaOAuthCallback).not.toHaveBeenCalled();
  });

  it("calendar and meta: a failing session lookup is a generic error, not a completion", async () => {
    m.session.mockRejectedValue(new Error("db password=hunter2 unreachable"));
    const cal = await calendar(
      `code=c&state=${encodeURIComponent(buildOAuthState(ctx, "GOOGLE"))}`,
    );
    const met = await meta(
      `code=c&state=${encodeURIComponent(buildSocialOAuthState("org-a", "user-a", "FACEBOOK"))}`,
    );

    expect(errorParam(cal, "calendar_error")).toBe("connect_failed");
    expect(errorParam(met, "social_error")).toBe("connect_failed");
    for (const res of [cal, met]) expect(res.headers.get("location")).not.toContain("hunter2");
    expect(m.completeConnection).not.toHaveBeenCalled();
    expect(m.completeMetaOAuthCallback).not.toHaveBeenCalled();
  });

  it("calendar and meta: an internal completion error never reaches the redirect", async () => {
    m.session.mockResolvedValue({ userId: "user-a", orgId: "org-a" });
    m.completeConnection.mockRejectedValueOnce(new Error("token endpoint said secret=abc"));
    m.completeMetaOAuthCallback.mockRejectedValueOnce(new Error("graph said secret=abc"));

    const cal = await calendar(
      `code=c&state=${encodeURIComponent(buildOAuthState(ctx, "GOOGLE"))}`,
    );
    const met = await meta(
      `code=c&state=${encodeURIComponent(buildSocialOAuthState("org-a", "user-a", "FACEBOOK"))}`,
    );

    expect(errorParam(cal, "calendar_error")).toBe("connect_failed");
    expect(errorParam(met, "social_error")).toBe("connect_failed");
    for (const res of [cal, met]) expect(res.headers.get("location")).not.toContain("secret");
  });
});
