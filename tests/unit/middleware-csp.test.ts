import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

function requestFor(path: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(new URL(path, "http://localhost:3000"));
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

describe("middleware CSP", () => {
  it("sets a nonce-based Content-Security-Policy on a public page response", () => {
    const response = middleware(requestFor("/en/login"));
    const csp = response.headers.get("Content-Security-Policy");

    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("generates a fresh nonce on every request", () => {
    const first = middleware(requestFor("/en/login")).headers.get("Content-Security-Policy");
    const second = middleware(requestFor("/en/login")).headers.get("Content-Security-Policy");

    const extractNonce = (csp: string | null) => csp?.match(/'nonce-([^']+)'/)?.[1];
    expect(extractNonce(first)).toBeTruthy();
    expect(extractNonce(first)).not.toBe(extractNonce(second));
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
