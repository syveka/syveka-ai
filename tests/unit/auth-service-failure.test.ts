import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthApiError,
  AuthInvalidJwtError,
  AuthRefreshDiscardedError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from "@supabase/supabase-js";

/**
 * A session check that fails because Supabase Auth is down must stay
 * observable; one that finds no valid session is an expected state. Both
 * reach the app as "no user". Uses the real @supabase/auth-js error classes
 * (re-exported by @supabase/supabase-js), so a change in how the library
 * reports either case fails here.
 */

const m = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServer: async () => ({ auth: { getUser: m.getUser } }),
}));
vi.mock("@/server/db/prisma", () => ({ prisma: {} }));

import { isAuthServiceFailure } from "@/server/auth/auth-service-failure";
import { assertAuthServiceAvailable, getSessionLookup } from "@/server/auth/session";

const expected: Array<[string, unknown]> = [
  ["no session (AuthSessionMissingError)", new AuthSessionMissingError()],
  ["invalid JWT", new AuthInvalidJwtError("invalid JWT")],
  ["expired or bad token (401)", new AuthApiError("JWT expired", 401, "bad_jwt")],
  ["deleted user (403)", new AuthApiError("User not found", 403, "user_not_found")],
  [
    "refresh token no longer valid (400)",
    new AuthApiError(
      "Invalid Refresh Token: Refresh Token Not Found",
      400,
      "refresh_token_not_found",
    ),
  ],
  ["refresh discarded by a concurrent one (409)", new AuthRefreshDiscardedError()],
  ["no error", null],
];

const outages: Array<[string, unknown]> = [
  ["network failure or timeout", new AuthRetryableFetchError("fetch failed", 0)],
  ["503 from the service", new AuthRetryableFetchError("Service Unavailable", 503)],
  ["unreadable response", new AuthUnknownError("Unexpected token <", {})],
  ["500 from the service", new AuthApiError("Internal error", 500, "unexpected_failure")],
  ["rate limited (429)", new AuthApiError("Too many requests", 429, "over_request_rate_limit")],
];

describe("isAuthServiceFailure", () => {
  it.each(expected)("%s: an expected state, not an outage", (_, error) => {
    expect(isAuthServiceFailure(error)).toBe(false);
  });

  it.each(outages)("%s: an auth-service failure", (_, error) => {
    expect(isAuthServiceFailure(error)).toBe(true);
  });
});

describe("getSessionLookup and assertAuthServiceAvailable", () => {
  beforeEach(() => {
    m.getUser.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each(expected)("%s: no user, no failure, nothing thrown", async (_, error) => {
    m.getUser.mockResolvedValue({ data: { user: null }, error });
    await expect(getSessionLookup()).resolves.toEqual({ user: null, serviceFailure: false });
    await expect(assertAuthServiceAvailable()).resolves.toBeUndefined();
  });

  it.each(outages)(
    "%s: reported as a service failure; the assertion throws a typed error",
    async (_, error) => {
      m.getUser.mockResolvedValue({ data: { user: null }, error });
      await expect(getSessionLookup()).resolves.toEqual({ user: null, serviceFailure: true });
      await expect(assertAuthServiceAvailable()).rejects.toMatchObject({
        name: "AuthServiceUnavailableError",
        message: "Auth service unavailable",
      });
    },
  );

  it("a signed-in user is never a failure", async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    await expect(getSessionLookup()).resolves.toEqual({
      user: { id: "user-1" },
      serviceFailure: false,
    });
    await expect(assertAuthServiceAvailable()).resolves.toBeUndefined();
  });

  it("the provider's error text is never carried on the thrown error", async () => {
    m.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError("connect ECONNREFUSED 10.0.0.1:443 token=abc", 0),
    });
    const thrown = await assertAuthServiceAvailable().catch((e: unknown) => e);
    expect(String((thrown as Error).message)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(thrown)).not.toContain("token=");
  });
});
