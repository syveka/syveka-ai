import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OAuth callbacks bind the flow to (org, user) through signed state. The browser finishing the
 * flow must also be signed in as that user: otherwise an attacker sends a victim their own
 * authorization URL and the victim's calendar or Facebook Page is stored under the attacker's
 * organization (login CSRF).
 */
const m = vi.hoisted(() => ({
  session: vi.fn(),
  completeConnection: vi.fn(async () => ({ orgId: "org-attacker", connectionId: "c1" })),
  completeMetaOAuthCallback: vi.fn(async () => ({ orgId: "org-attacker", accountId: "a1" })),
}));

vi.mock("@/server/auth/session", () => ({ getTenantContextOrNull: m.session }));
vi.mock("@/server/services/calendar-connections", () => {
  class ConnectionError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    ConnectionError,
    completeConnection: m.completeConnection,
    verifyOAuthState: (state: string) => {
      if (state === "bad") throw new ConnectionError("bad", "bad_state");
      return { orgId: "org-attacker", userId: state, provider: "GOOGLE" };
    },
  };
});
vi.mock("@/server/social/oauth-state", () => {
  class SocialOAuthStateError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    SocialOAuthStateError,
    verifySocialOAuthState: (state: string) => {
      if (state === "bad") throw new SocialOAuthStateError("bad", "bad_state");
      return { orgId: "org-attacker", userId: state, platform: "FACEBOOK" };
    },
  };
});
vi.mock("@/server/services/creator-social-accounts", () => ({
  SocialConnectError: class extends Error {},
  completeMetaOAuthCallback: m.completeMetaOAuthCallback,
}));

import { GET as calendarCallback } from "@/app/api/v1/integrations/calendar/[provider]/callback/route";
import { GET as metaCallback } from "@/app/api/v1/creator-studio/social-accounts/oauth/meta/callback/route";

const calendar = (state: string) =>
  calendarCallback(
    new Request(
      `https://app.example/api/v1/integrations/calendar/google/callback?code=c&state=${state}`,
    ),
    { params: Promise.resolve({ provider: "google" }) },
  );
const meta = (state: string) =>
  metaCallback(
    new Request(
      `https://app.example/api/v1/creator-studio/social-accounts/oauth/meta/callback?code=c&state=${state}`,
    ),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OAuth callbacks are finished only by the user who started them", () => {
  for (const [name, call, complete, param] of [
    ["calendar", calendar, m.completeConnection, "calendar_error"],
    ["meta", meta, m.completeMetaOAuthCallback, "social_error"],
  ] as const) {
    it(`${name}: refuses a victim's session completing an attacker's state`, async () => {
      m.session.mockResolvedValueOnce({ userId: "victim", orgId: "org-victim" });
      const res = await call("attacker");
      expect(new URL(res.headers.get("location")!).searchParams.get(param)).toBe(
        "session_mismatch",
      );
      expect(complete).not.toHaveBeenCalled();
    });

    it(`${name}: refuses when nobody is signed in`, async () => {
      m.session.mockResolvedValueOnce(null);
      const res = await call("attacker");
      expect(new URL(res.headers.get("location")!).searchParams.get(param)).toBe(
        "session_mismatch",
      );
      expect(complete).not.toHaveBeenCalled();
    });

    it(`${name}: refuses a tampered state before anything else`, async () => {
      m.session.mockResolvedValueOnce({ userId: "user-1", orgId: "org-a" });
      const res = await call("bad");
      expect(new URL(res.headers.get("location")!).searchParams.get(param)).toBe("bad_state");
      expect(complete).not.toHaveBeenCalled();
    });

    it(`${name}: completes for the user who started the flow`, async () => {
      m.session.mockResolvedValueOnce({ userId: "user-1", orgId: "org-a" });
      await call("user-1");
      expect(complete).toHaveBeenCalledTimes(1);
    });
  }
});
