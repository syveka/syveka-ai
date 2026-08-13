import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { intlMiddlewareMock } = vi.hoisted(() => ({ intlMiddlewareMock: vi.fn() }));

vi.mock("next-intl/middleware", () => ({
  default: vi.fn(() => intlMiddlewareMock),
}));

vi.mock("@/i18n/routing", () => ({
  routing: { locales: ["en", "fi", "ar"], defaultLocale: "en" },
}));

import { buildContentSecurityPolicy, generateNonce, middleware } from "@/middleware";

function requestFor(path: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(new URL(path, "http://localhost:3000"));
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

describe("middleware CSP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
    intlMiddlewareMock.mockImplementation((request: NextRequest) =>
      NextResponse.next({ request: { headers: new Headers(request.headers) } }),
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

  it("sets a nonce-based Content-Security-Policy on a public page response", () => {
    const response = middleware(requestFor("/en/login"));
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("forwards the same nonce and CSP to Next's downstream renderer", () => {
    const response = middleware(requestFor("/en/login"));
    const responseCsp = response.headers.get("Content-Security-Policy");
    const responseNonce = responseCsp?.match(/'nonce-([^']+)'/)?.[1];

    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(responseNonce);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(responseCsp);
    const overrides = response.headers.get("x-middleware-override-headers")?.toLowerCase();
    expect(overrides).toContain("x-nonce");
    expect(overrides).toContain("content-security-policy");
  });

  it("generates a fresh nonce on every request", () => {
    const first = middleware(requestFor("/en/login")).headers.get("Content-Security-Policy");
    const second = middleware(requestFor("/en/login")).headers.get("Content-Security-Policy");

    const extractNonce = (csp: string | null) => csp?.match(/'nonce-([^']+)'/)?.[1];
    expect(extractNonce(first)).toBeTruthy();
    expect(extractNonce(first)).not.toBe(extractNonce(second));
  });

  it("generates base64-shaped nonces without Node-only Buffer APIs", () => {
    expect(generateNonce()).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("still applies the CSP header to an auth redirect for a protected route", () => {
    const response = middleware(requestFor("/en/dashboard"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
    expect(response.headers.get("Content-Security-Policy")).toMatch(/nonce-/);
  });

  it("does not redirect a protected route when a Supabase session cookie is present", () => {
    const response = middleware(
      requestFor("/en/dashboard", { "sb-project-auth-token": "session" }),
    );

    expect(response.status).not.toBe(307);
    expect(response.headers.get("Content-Security-Policy")).toMatch(/nonce-/);
  });
});
