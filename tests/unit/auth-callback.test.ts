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

  it.each([
    "https://evil.example/onboarding",
    "//evil.example/onboarding",
    "/\\\\evil.example/onboarding",
    "/%5C%5Cevil.example/onboarding",
    "/%2F%2Fevil.example/onboarding",
  ])("rejects external next target %s", async (next) => {
    const response = await GET(request(`?code=code&next=${encodeURIComponent(next)}`));
    expect(response.headers.get("location")).toBe("https://staging.example.test/onboarding");
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
