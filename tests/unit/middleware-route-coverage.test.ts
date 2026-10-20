import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * The middleware's protected-prefix list must cover every signed-in route
 * group. A route left out still can't be read signed out -- (app)/layout.tsx
 * redirects to /onboarding without a tenant context -- but the visitor then
 * reaches /login with `next=/onboarding` and the page they asked for is lost.
 * /inbox and /creator-studio were added after the list and missed it.
 */

const { intlMiddlewareMock, mocks } = vi.hoisted(() => ({
  intlMiddlewareMock: vi.fn(),
  mocks: {
    getUser: vi.fn(async () => ({
      data: { user: null as { id: string; email: string } | null },
      error: null as unknown,
    })),
    createServerClient: vi.fn(),
  },
}));

vi.mock("next-intl/middleware", () => ({ default: vi.fn(() => intlMiddlewareMock) }));
vi.mock("@/i18n/routing", () => ({
  routing: { locales: ["en", "fi", "ar"], defaultLocale: "fi" },
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));

import { PROTECTED_PREFIXES, middleware } from "@/middleware";

/** Route groups whose every page needs a signed-in user. */
const SIGNED_IN_ROUTE_GROUPS = ["(app)", "(onboarding)", "(superadmin)"];
const appRoot = path.join(__dirname, "../../src/app/[locale]");

function routeDirectories(group: string): string[] {
  return fs
    .readdirSync(path.join(appRoot, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name);
}

const isProtected = (routePath: string) =>
  PROTECTED_PREFIXES.some((p) => routePath === p || routePath.startsWith(`${p}/`));

describe("protected prefixes cover every signed-in route group", () => {
  it("lists every route directory of (app), (onboarding) and (superadmin)", () => {
    const uncovered = SIGNED_IN_ROUTE_GROUPS.flatMap((group) =>
      routeDirectories(group)
        .map((dir) => `/${dir}`)
        .filter((routePath) => !isProtected(routePath)),
    );
    expect(uncovered, "add these to PROTECTED_PREFIXES in src/middleware.ts").toEqual([]);
  });

  it("names only routes that exist, so a renamed route can't keep a stale entry", () => {
    const existing = new Set(
      SIGNED_IN_ROUTE_GROUPS.flatMap((group) => routeDirectories(group).map((dir) => `/${dir}`)),
    );
    expect(PROTECTED_PREFIXES.filter((p) => !existing.has(p))).toEqual([]);
  });

  it("leaves the public, marketing and auth groups alone", () => {
    for (const group of ["(public)", "(marketing)", "(auth)"]) {
      for (const dir of routeDirectories(group)) {
        expect(isProtected(`/${dir}`), `/${dir} must stay public`).toBe(false);
      }
    }
  });
});

describe("a signed-out visit to a previously uncovered app route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    intlMiddlewareMock.mockImplementation((request: NextRequest) =>
      NextResponse.next({ request: { headers: new Headers(request.headers) } }),
    );
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    mocks.createServerClient.mockImplementation(() => ({ auth: { getUser: mocks.getUser } }));
  });

  it.each([
    ["/en/inbox", "/inbox"],
    ["/en/inbox/thread-1", "/inbox/thread-1"],
    ["/creator-studio", "/creator-studio"],
    ["/ar/creator-studio/generations", "/creator-studio/generations"],
  ])("%s goes to login with the asked-for page as next", async (visited, expectedNext) => {
    const response = await middleware(new NextRequest(new URL(visited, "http://localhost:3000")));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(expectedNext);
    expect(response.headers.get("Content-Security-Policy")).toMatch(/nonce-/);
  });

  it("still lets a signed-in user through to those routes", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "user@example.com" } },
      error: null,
    });
    for (const visited of ["/en/inbox", "/en/creator-studio"]) {
      const response = await middleware(new NextRequest(new URL(visited, "http://localhost:3000")));
      expect(response.status, visited).not.toBe(307);
    }
  });
});
