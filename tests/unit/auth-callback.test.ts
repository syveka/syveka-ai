import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ exchangeCodeForSession: vi.fn() }));

vi.mock("@/server/supabase/server", () => ({
  createSupabaseRouteClient: () => ({
    auth: { exchangeCodeForSession: mocks.exchangeCodeForSession },
  }),
}));

import { GET } from "@/app/api/auth/callback/route";

function request(query: string) {
  return new NextRequest(`https://staging.example.test/api/auth/callback${query}`);
}

describe("Supabase PKCE callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
  });

  it("exchanges the code exactly once and preserves the locale", async () => {
    const response = await GET(request("?code=one-time-code&next=%2Far%2Fonboarding"));

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("one-time-code");
    expect(response.headers.get("location")).toBe("https://staging.example.test/ar/onboarding");
  });

  it("a password-recovery callback (next=/reset-password) lands on the reset form, not onboarding", async () => {
    const response = await GET(request("?code=recovery-code&next=%2Fen%2Freset-password"));

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("recovery-code");
    expect(response.headers.get("location")).toBe("https://staging.example.test/en/reset-password");
  });

  it.each([
    "https://evil.example/onboarding",
    "//evil.example/onboarding",
    "/\\\\evil.example/onboarding",
    "/%5C%5Cevil.example/onboarding",
    "/%2F%2Fevil.example/onboarding",
  ])("rejects external next target %s", async (next) => {
    const response = await GET(request(`?code=code&next=${encodeURIComponent(next)}`));
    // /dashboard, not /onboarding -- this fallback fires for every callback
    // flow (signup, magic link, password recovery), not only fresh signups,
    // and must not misroute an existing account recovering its password into
    // "Create your organization". See safeInternalNext's own doc comment.
    expect(response.headers.get("location")).toBe("https://staging.example.test/dashboard");
  });

  it("falls back to /dashboard, not /onboarding, when next is missing entirely", async () => {
    // Regression test for the exact Staging incident: a password-recovery
    // callback that arrives with no `next` (e.g. because it wasn't
    // preserved further upstream) must land an existing account on its own
    // dashboard, never on the "Create your organization" screen.
    const response = await GET(request("?code=code"));
    expect(response.headers.get("location")).toBe("https://staging.example.test/dashboard");
  });

  it("fails safely when the code is missing", async () => {
    const response = await GET(request("?next=%2Fen%2Fonboarding"));
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "https://staging.example.test/en/login?error=auth_callback_failed",
    );
  });

  it("fails safely when the code is expired or invalid", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: new Error("expired") });
    const response = await GET(request("?code=expired&next=%2Ffi%2Fonboarding"));
    expect(response.headers.get("location")).toBe(
      "https://staging.example.test/fi/login?error=auth_callback_failed",
    );
  });
});
