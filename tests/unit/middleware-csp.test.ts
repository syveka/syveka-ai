import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type SupabaseUser = { id: string; email?: string };
type CookieToSet = { name: string; value: string; options: Record<string, unknown> };
type SupabaseCookieOptions = {
  cookies: {
    getAll: () => Array<{ name: string; value: string }>;
    setAll: (c: CookieToSet[]) => void;
  };
};

const { intlMiddlewareMock, mocks } = vi.hoisted(() => ({
  intlMiddlewareMock: vi.fn(),
  mocks: {
    getUser: vi.fn(async () => ({
      data: { user: null as SupabaseUser | null },
      error: null as unknown,
    })),
    createServerClient: vi.fn(),
  },
}));

vi.mock("next-intl/middleware", () => ({
  default: vi.fn(() => intlMiddlewareMock),
}));

vi.mock("@/i18n/routing", () => ({
  routing: { locales: ["en", "fi", "ar"], defaultLocale: "en" },
}));

let lastCookieOptions: SupabaseCookieOptions | undefined;

vi.mock("@supabase/ssr", () => ({
  createServerClient: mocks.createServerClient,
}));

import { buildContentSecurityPolicy, generateNonce, middleware } from "@/middleware";

function requestFor(path: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(new URL(path, "http://localhost:3000"));
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

const VALID_USER: SupabaseUser = { id: "user-1", email: "user@example.com" };

describe("middleware CSP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    intlMiddlewareMock.mockImplementation((request: NextRequest) =>
      NextResponse.next({ request: { headers: new Headers(request.headers) } }),
    );
    lastCookieOptions = undefined;
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    mocks.createServerClient.mockImplementation(
      (_url: string, _key: string, options: SupabaseCookieOptions) => {
        lastCookieOptions = options;
        return { auth: { getUser: mocks.getUser } };
      },
    );
  });

  it("pins browser Supabase traffic to the configured HTTPS and WSS origins", () => {
    const csp = buildContentSecurityPolicy("test-nonce");
    expect(csp).toContain(
      "connect-src 'self' https://abcdefghijklmnop.supabase.co wss://abcdefghijklmnop.supabase.co",
    );
    expect(csp).toContain("https://abcdefghijklmnop.supabase.co");
    expect(csp).not.toContain("*.supabase.co");
  });

  it("allows only the verified image and media origin classes", () => {
    const csp = buildContentSecurityPolicy("test-nonce");
    expect(csp).toContain("https://lh3.googleusercontent.com");
    expect(csp).toContain("media-src 'self' https:");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("fails closed when the configured Supabase URL is malformed", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not-a-url";
    const csp = buildContentSecurityPolicy("test-nonce");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("supabase.co");
  });

  it("sets a nonce-based Content-Security-Policy on a public page response", async () => {
    const response = await middleware(requestFor("/en/login"));
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("forwards the same nonce and CSP to Next's downstream renderer", async () => {
    const response = await middleware(requestFor("/en/login"));
    const responseCsp = response.headers.get("Content-Security-Policy");
    const responseNonce = responseCsp?.match(/'nonce-([^']+)'/)?.[1];

    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(responseNonce);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(responseCsp);
    const overrides = response.headers.get("x-middleware-override-headers")?.toLowerCase();
    expect(overrides).toContain("x-nonce");
    expect(overrides).toContain("content-security-policy");
  });

  it("generates a fresh nonce on every request", async () => {
    const first = (await middleware(requestFor("/en/login"))).headers.get(
      "Content-Security-Policy",
    );
    const second = (await middleware(requestFor("/en/login"))).headers.get(
      "Content-Security-Policy",
    );

    const extractNonce = (csp: string | null) => csp?.match(/'nonce-([^']+)'/)?.[1];
    expect(extractNonce(first)).toBeTruthy();
    expect(extractNonce(first)).not.toBe(extractNonce(second));
  });

  it("generates base64-shaped nonces without Node-only Buffer APIs", () => {
    expect(generateNonce()).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  describe("session-validated authorization (BLOCKER A)", () => {
    it("redirects a protected route to login when no auth cookie exists at all", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
      const response = await middleware(requestFor("/en/dashboard"));

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/login");
      expect(response.headers.get("Content-Security-Policy")).toMatch(/nonce-/);
    });

    it("redirects a protected route to login when a stale/invalid auth cookie is present", async () => {
      // A cookie *named* like a Supabase session cookie exists, but getUser()
      // — which actually revalidates against Supabase — rejects it. This is
      // exactly the AuthSessionMissingError condition proven in staging: a
      // cookie name match must never substitute for real validation.
      mocks.getUser.mockResolvedValue({
        data: { user: null },
        error: { name: "AuthSessionMissingError", status: 400, code: null },
      });
      const response = await middleware(
        requestFor("/en/dashboard", { "sb-project-auth-token": "stale-or-empty" }),
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/login");
    });

    it("allows a protected route through when the session is genuinely valid", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: VALID_USER }, error: null });
      const response = await middleware(
        requestFor("/en/dashboard", { "sb-project-auth-token": "a-real-session" }),
      );

      expect(response.status).not.toBe(307);
      expect(response.headers.get("Content-Security-Policy")).toMatch(/nonce-/);
    });

    it("propagates a refreshed session cookie onto the outgoing response", async () => {
      mocks.getUser.mockImplementation(async () => {
        // Mirrors real @supabase/ssr behavior: getUser() can trigger a token
        // refresh, which calls the cookies.setAll hook we handed it.
        lastCookieOptions?.cookies.setAll([
          {
            name: "sb-project-auth-token",
            value: "refreshed-session",
            options: { httpOnly: true },
          },
        ]);
        return { data: { user: VALID_USER }, error: null };
      });

      const response = await middleware(
        requestFor("/en/dashboard", { "sb-project-auth-token": "about-to-expire" }),
      );

      expect(response.cookies.get("sb-project-auth-token")?.value).toBe("refreshed-session");
    });

    it("propagates a refreshed session cookie even on an auth-page-to-dashboard redirect", async () => {
      mocks.getUser.mockImplementation(async () => {
        lastCookieOptions?.cookies.setAll([
          {
            name: "sb-project-auth-token",
            value: "refreshed-session",
            options: { httpOnly: true },
          },
        ]);
        return { data: { user: VALID_USER }, error: null };
      });

      const response = await middleware(requestFor("/en/login"));

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/dashboard");
      expect(response.cookies.get("sb-project-auth-token")?.value).toBe("refreshed-session");
    });

    it("redirects an authenticated user away from login to the dashboard", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: VALID_USER }, error: null });
      const response = await middleware(
        requestFor("/en/login", { "sb-project-auth-token": "a-real-session" }),
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/dashboard");
    });

    it("does not redirect an unauthenticated visitor away from login", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
      const response = await middleware(requestFor("/en/login"));

      expect(response.status).not.toBe(307);
    });

    it("still applies the CSP header to an auth redirect for a protected route", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
      const response = await middleware(requestFor("/en/dashboard"));

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/login");
      expect(response.headers.get("Content-Security-Policy")).toMatch(/nonce-/);
    });
  });

  describe("locale routing remains intact", () => {
    it("still applies the CSP and forwarded headers on the default-locale root", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
      const response = await middleware(requestFor("/"));

      expect(response.headers.get("Content-Security-Policy")).toMatch(/nonce-/);
    });

    it("strips a locale prefix before matching protected/auth-page prefixes", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: VALID_USER }, error: null });
      const withLocale = await middleware(
        requestFor("/fi/login", { "sb-project-auth-token": "a-real-session" }),
      );
      expect(withLocale.status).toBe(307);
      expect(withLocale.headers.get("location")).toContain("/dashboard");
    });

    it("treats an unprotected, non-auth page identically regardless of session state", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
      const response = await middleware(requestFor("/en/pricing"));
      expect(response.status).not.toBe(307);
    });
  });
});
