import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

// The email-link flow that works in any browser: the template links to
// /api/auth/callback with `token_hash` and `type`, and the server verifies it
// with verifyOtp (no PKCE verifier needed). See docs/auth-email-links.md.

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
  response: null as NextResponse | null,
}));

vi.mock("@/server/supabase/server", () => ({
  createSupabaseRouteClient: (_request: unknown, response: NextResponse) => {
    mocks.response = response;
    return {
      auth: {
        exchangeCodeForSession: mocks.exchangeCodeForSession,
        verifyOtp: mocks.verifyOtp,
      },
    };
  },
}));

import { GET } from "@/app/api/auth/callback/route";

const SESSION_COOKIE = "sb-test-auth-token";
const TOKEN_HASH = "pkce_0123456789abcdef0123456789abcdef0123456789abcdef01234567";
const INVITATION_ID = "3f0c2b9e-8a41-4d2e-9b7c-1e5f6a7b8c9d";

function request(query: string) {
  return new NextRequest(`https://staging.example.test/api/auth/callback${query}`);
}

function link(type: string, next?: string, tokenHash = TOKEN_HASH) {
  const query = new URLSearchParams({ token_hash: tokenHash, type });
  if (next !== undefined) query.set("next", next);
  return request(`?${query}`);
}

describe("Supabase token-hash email links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.response = null;
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
    // A successful verification sets the session cookie on the client's response.
    mocks.verifyOtp.mockImplementation(async () => {
      mocks.response?.cookies.set(SESSION_COOKIE, "session-value", { path: "/" });
      return { data: {}, error: null };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("password recovery", () => {
    it("verifies exactly { token_hash, type: 'recovery' } and lands on the reset form with the session", async () => {
      const response = await GET(link("recovery", "/en/reset-password"));

      expect(mocks.verifyOtp).toHaveBeenCalledTimes(1);
      expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN_HASH, type: "recovery" });
      expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(response.headers.get("location")).toBe(
        "https://staging.example.test/en/reset-password",
      );
      // The session cookie is on the redirect that is actually returned.
      expect(response).toBe(mocks.response);
      expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("session-value");
    });

    it.each([
      ["/ar/dashboard", "https://staging.example.test/ar/reset-password"],
      ["/en/settings/members", "https://staging.example.test/en/reset-password"],
      [undefined, "https://staging.example.test/fi/reset-password"],
      ["https://evil.test/en/reset-password", "https://staging.example.test/fi/reset-password"],
    ])("always lands on the reset form (next=%s)", async (next, expected) => {
      const response = await GET(link("recovery", next));
      expect(response.headers.get("location")).toBe(expected);
    });
  });

  describe("sign-up confirmation and magic link", () => {
    it.each(["email", "signup"])("type=%s confirms and follows the safe next", async (type) => {
      const response = await GET(link(type, "/ar/onboarding"));

      expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN_HASH, type });
      expect(response.headers.get("location")).toBe("https://staging.example.test/ar/onboarding");
      expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("session-value");
    });

    it("keeps an invitation continuation on success", async () => {
      const response = await GET(link("email", `/fi/invite/${INVITATION_ID}`));
      expect(response.headers.get("location")).toBe(
        `https://staging.example.test/fi/invite/${INVITATION_ID}`,
      );
    });

    it("type=magiclink is accepted", async () => {
      const response = await GET(link("magiclink", "/en/dashboard"));
      expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN_HASH, type: "magiclink" });
      expect(response.headers.get("location")).toBe("https://staging.example.test/en/dashboard");
    });

    it.each([
      "https://evil.test/onboarding",
      "//evil.test/onboarding",
      "/\\evil.test/onboarding",
      "/%5C%5Cevil.test/onboarding",
      "/%2F%2Fevil.test/onboarding",
    ])("rejects external next target %s", async (next) => {
      const response = await GET(link("email", next));
      expect(response.headers.get("location")).toBe("https://staging.example.test/dashboard");
    });
  });

  describe("refused links", () => {
    it.each(["invite", "email_change", "sms", "phone_change", "RECOVERY", "", "unknown"])(
      "type=%s is not in the allowlist: failed, verifyOtp not called",
      async (type) => {
        const response = await GET(link(type, "/en/reset-password"));
        expect(mocks.verifyOtp).not.toHaveBeenCalled();
        expect(response.headers.get("location")).toBe(
          "https://staging.example.test/en/login?error=auth_callback_failed",
        );
      },
    );

    it("type missing: failed", async () => {
      const response = await GET(
        request(`?token_hash=${TOKEN_HASH}&next=${encodeURIComponent("/en/reset-password")}`),
      );
      expect(mocks.verifyOtp).not.toHaveBeenCalled();
      expect(response.headers.get("location")).toBe(
        "https://staging.example.test/en/login?error=auth_callback_failed",
      );
    });

    it.each([
      ["missing", `?type=recovery&next=${encodeURIComponent("/en/reset-password")}`],
      ["empty", `?token_hash=&type=recovery&next=${encodeURIComponent("/en/reset-password")}`],
    ])("token_hash %s: failed, verifyOtp not called", async (_label, query) => {
      const response = await GET(request(query));
      expect(mocks.verifyOtp).not.toHaveBeenCalled();
      expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(response.headers.get("location")).toBe(
        "https://staging.example.test/en/login?error=auth_callback_failed",
      );
    });

    it("an expired or used link fails without a session", async () => {
      mocks.verifyOtp.mockResolvedValue({
        data: {},
        error: Object.assign(new Error("Email link is invalid or has expired"), {
          code: "otp_expired",
        }),
      });
      const response = await GET(link("recovery", "/en/reset-password"));
      expect(response.headers.get("location")).toBe(
        "https://staging.example.test/en/login?error=auth_callback_failed",
      );
      expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    });

    it("a failed confirmation keeps the invitation continuation", async () => {
      mocks.verifyOtp.mockResolvedValue({ data: {}, error: new Error("expired") });
      const response = await GET(link("email", `/ar/invite/${INVITATION_ID}`));
      expect(response.headers.get("location")).toBe(
        `https://staging.example.test/ar/login?error=auth_callback_failed&next=${encodeURIComponent(
          `/invite/${INVITATION_ID}`,
        )}`,
      );
    });
  });

  it("a PKCE code still takes the code path, unchanged", async () => {
    const response = await GET(
      request(
        `?code=one-time-code&token_hash=${TOKEN_HASH}&type=recovery&next=${encodeURIComponent(
          "/ar/onboarding",
        )}`,
      ),
    );
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("one-time-code");
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://staging.example.test/ar/onboarding");
  });

  it("the token hash never reaches logs or the redirect URL", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }

    const locationOf = async (req: NextRequest) => (await GET(req)).headers.get("location");
    const locations = [
      await locationOf(link("recovery", "/en/reset-password")),
      await locationOf(link("invite", "/en/reset-password")),
    ];
    mocks.verifyOtp.mockResolvedValue({ data: {}, error: new Error(`bad ${TOKEN_HASH}`) });
    locations.push(await locationOf(link("email", `/en/invite/${INVITATION_ID}`)));

    for (const location of locations) {
      expect(location).not.toBeNull();
      expect(location).not.toContain(TOKEN_HASH);
      expect(location).not.toContain("token_hash");
    }
    expect(JSON.stringify(logged.map(String))).not.toContain(TOKEN_HASH);
  });
});
