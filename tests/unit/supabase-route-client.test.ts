import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn((_url: string, _key: string, _options: unknown) => ({ auth: {} })),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { createSupabaseRouteClient } from "@/server/supabase/server";

const snapshot = {
  SKIP_ENV_VALIDATION: process.env.SKIP_ENV_VALIDATION,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

describe("Supabase route client cookie propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SKIP_ENV_VALIDATION = "1";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("copies PKCE/session cookies onto the exact redirect response", () => {
    const request = new NextRequest("https://staging.example.test/api/auth/callback", {
      headers: { cookie: "sb-code-verifier=verifier" },
    });
    const response = NextResponse.redirect("https://staging.example.test/en/onboarding");

    createSupabaseRouteClient(request, response);
    const options = mocks.createServerClient.mock.calls[0]?.[2] as {
      cookies: {
        getAll: () => Array<{ name: string; value: string }>;
        setAll: (values: Array<{ name: string; value: string; options: object }>) => void;
      };
    };

    expect(options.cookies.getAll()).toEqual(
      expect.arrayContaining([{ name: "sb-code-verifier", value: "verifier" }]),
    );
    options.cookies.setAll([
      { name: "sb-project-auth-token", value: "session", options: { httpOnly: true } },
    ]);

    expect(response.cookies.get("sb-project-auth-token")?.value).toBe("session");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
});
