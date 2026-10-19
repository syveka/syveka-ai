import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An invited person who isn't signed in is sent to register with
 * `next=/invite/<token>`. Registering (after email verification) or signing
 * in must bring them back to that invitation, where they accept it
 * themselves; it is never accepted for them. Only an invitation path is
 * honoured as `next`: anything else keeps the usual destination.
 */

const INVITATION_ID = "3f0c2b9e-8a41-4d2e-9b7c-1e5f6a7b8c9d";
const INVITE = `/invite/${INVITATION_ID}`;

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({ success: true })),
  signInWithPassword: vi.fn(async (): Promise<{ error: Error | null }> => ({ error: null })),
  signUp: vi.fn(async (_args: { options: { emailRedirectTo: string } }) => ({ error: null })),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  getSessionUser: vi.fn(),
  findInvitation: vi.fn(),
  findUser: vi.fn(),
  updateInvitation: vi.fn(async () => ({})),
  transaction: vi.fn(),
  acceptInvitationAction: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({ Redis: class Redis {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class Ratelimit {
    static slidingWindow() {
      return {};
    }
    limit = mocks.rateLimit;
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/env", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppUrlEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.example.test" }),
  getRedisEnv: () => ({
    UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "test-token",
  }),
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServer: async () => ({
    auth: { signInWithPassword: mocks.signInWithPassword, signUp: mocks.signUp },
  }),
  createSupabaseAdmin: () => ({ auth: { admin: { updateUserById: vi.fn() } } }),
}));
vi.mock("@/server/auth/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    invitation: { findUnique: mocks.findInvitation, update: mocks.updateInvitation },
    user: { findUniqueOrThrow: mocks.findUser },
    $transaction: mocks.transaction,
  },
  tenantDb: () => ({}),
}));
vi.mock("@/actions/members", () => ({ acceptInvitationAction: mocks.acceptInvitationAction }));
vi.mock("@/i18n/routing", () => ({ Link: () => null }));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale: "en",
        messages: JSON.parse(
          fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
        ),
        namespace,
      }),
  };
});
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(),
  getEntitlements: vi.fn(async () => ({ maxSeats: 10, readOnly: false })),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/billing/seats", () => ({
  countActiveSeats: vi.fn(),
  lockOrgSeats: vi.fn(),
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: () => null }));

import { loginAction, registerAction } from "@/actions/auth";
import { inviteContinuation } from "@/lib/auth-redirect";
import { acceptInvitation, InvitationAccountMismatchError } from "@/server/services/members";
import InvitePage from "@/app/[locale]/(auth)/invite/[token]/page";

function loginForm(next?: string, locale = "en") {
  const form = new FormData();
  form.set("email", "invitee@example.test");
  form.set("password", "password");
  form.set("locale", locale);
  if (next !== undefined) form.set("next", next);
  return form;
}

function registerForm(next?: string, locale = "en") {
  const form = new FormData();
  form.set("fullName", "Invited Person");
  form.set("email", "invitee@example.test");
  form.set("password", "a-secure-password");
  form.set("locale", locale);
  if (next !== undefined) form.set("next", next);
  return form;
}

const emailRedirectTo = () => mocks.signUp.mock.calls[0]![0].options.emailRedirectTo;

const pendingInvitation = {
  id: "inv-1",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "invitee@example.test",
  role: "MEMBER",
  token: INVITATION_ID,
  status: "PENDING",
  expiresAt: new Date(Date.now() + 86_400_000),
  organization: { name: "Synthetic Org" },
};

/** Everything a client could send as `next` that must not be honoured. */
const REJECTED_NEXT = [
  "/dashboard",
  "/settings/members",
  `//evil.example${INVITE}`,
  `https://evil.example${INVITE}`,
  "/invite/not-a-token",
  `${INVITE}/extra`,
  `${INVITE}?x=1`,
  `${INVITE}#x`,
  "/invite/../dashboard",
  "/invite/%2e%2e%2fdashboard",
  `/en${INVITE}`,
  `\\invite\\${INVITATION_ID}`,
  "",
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("inviteContinuation", () => {
  it("accepts exactly an invitation path", () => {
    expect(inviteContinuation(INVITE)).toBe(INVITE);
  });

  it.each(REJECTED_NEXT)("ignores %j", (value) => {
    expect(inviteContinuation(value)).toBeNull();
  });

  it("ignores a missing or non-string value", () => {
    expect(inviteContinuation(null)).toBeNull();
    expect(inviteContinuation(undefined)).toBeNull();
    expect(inviteContinuation(["/invite", INVITATION_ID])).toBeNull();
    expect(inviteContinuation(new File([], "x"))).toBeNull();
  });
});

describe("register returns an invited user to the invitation", () => {
  it("new user: the verification link continues to the invitation, in their locale", async () => {
    await expect(registerAction({}, registerForm(INVITE, "ar"))).resolves.toEqual({
      message: "verify_email_sent",
    });
    expect(emailRedirectTo()).toBe(
      `https://app.example.test/api/auth/callback?next=${encodeURIComponent(`/ar${INVITE}`)}`,
    );
  });

  it("normal signup without an invitation still continues to onboarding", async () => {
    await registerAction({}, registerForm(undefined, "en"));
    expect(emailRedirectTo()).toBe(
      "https://app.example.test/api/auth/callback?next=%2Fen%2Fonboarding",
    );
  });

  it.each(REJECTED_NEXT)("a non-invitation next %j keeps onboarding", async (next) => {
    await registerAction({}, registerForm(next, "en"));
    expect(emailRedirectTo()).toBe(
      "https://app.example.test/api/auth/callback?next=%2Fen%2Fonboarding",
    );
  });
});

describe("login returns an invited user to the invitation", () => {
  it("existing user: signing in continues to the invitation, in their locale", async () => {
    await expect(loginAction({}, loginForm(INVITE, "fi"))).rejects.toThrow(
      `NEXT_REDIRECT:/fi${INVITE}`,
    );
  });

  it("normal login without an invitation still goes to the dashboard", async () => {
    await expect(loginAction({}, loginForm(undefined, "en"))).rejects.toThrow(
      "NEXT_REDIRECT:/en/dashboard",
    );
  });

  it.each(REJECTED_NEXT)("a non-invitation next %j keeps the dashboard", async (next) => {
    await expect(loginAction({}, loginForm(next, "en"))).rejects.toThrow(
      "NEXT_REDIRECT:/en/dashboard",
    );
  });

  it("wrong credentials don't redirect anywhere, invitation or not", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({ error: new Error("bad") });
    await expect(loginAction({}, loginForm(INVITE, "en"))).resolves.toEqual({
      error: "invalid_credentials",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("an invitation never bypasses the auth rate limit", () => {
  it.each([
    [
      "limit reached",
      () => mocks.rateLimit.mockResolvedValueOnce({ success: false }),
      "rate_limited",
    ],
    [
      "Redis unavailable",
      () => mocks.rateLimit.mockRejectedValueOnce(new Error("redis down")),
      "service_unavailable",
    ],
  ])("login, %s: refused before sign-in, no redirect", async (_label, arrange, error) => {
    arrange();
    await expect(loginAction({}, loginForm(INVITE, "en"))).resolves.toEqual({ error });
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each([
    [
      "limit reached",
      () => mocks.rateLimit.mockResolvedValueOnce({ success: false }),
      "rate_limited",
    ],
    [
      "Redis unavailable",
      () => mocks.rateLimit.mockRejectedValueOnce(new Error("redis down")),
      "service_unavailable",
    ],
  ])("register, %s: refused before sign-up", async (_label, arrange, error) => {
    arrange();
    await expect(registerAction({}, registerForm(INVITE, "en"))).resolves.toEqual({ error });
    expect(mocks.signUp).not.toHaveBeenCalled();
  });
});

describe("invitation page", () => {
  const page = (locale = "en", token = INVITATION_ID) =>
    InvitePage({ params: Promise.resolve({ locale, token }), searchParams: Promise.resolve({}) });

  it("signed out: sends to register in the page's locale, carrying the invitation", async () => {
    mocks.findInvitation.mockResolvedValue(pendingInvitation);
    mocks.getSessionUser.mockResolvedValue(null);

    await expect(page("ar")).rejects.toThrow(
      `NEXT_REDIRECT:/ar/register?next=${encodeURIComponent(INVITE)}`,
    );
  });

  it("signed in: shows the invitation without accepting it", async () => {
    mocks.findInvitation.mockResolvedValue(pendingInvitation);
    mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "invitee@example.test" });

    await expect(page()).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.acceptInvitationAction).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", null],
    ["already accepted", { ...pendingInvitation, status: "ACCEPTED" }],
    ["expired", { ...pendingInvitation, expiresAt: new Date(Date.now() - 1000) }],
  ])("%s invitation: not sent to register, nothing to accept", async (_label, invitation) => {
    mocks.findInvitation.mockResolvedValue(invitation);
    mocks.getSessionUser.mockResolvedValue(null);

    await expect(page()).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });
});

describe("accepting still requires the invited account", () => {
  it("a different signed-in user can't accept someone else's invitation", async () => {
    mocks.findInvitation.mockResolvedValue(pendingInvitation);
    mocks.findUser.mockResolvedValue({ id: "user-2", email: "someone-else@example.test" });

    await expect(acceptInvitation(INVITATION_ID, "user-2")).rejects.toThrow(
      "Invitation was sent to a different email address",
    );
    await expect(acceptInvitation(INVITATION_ID, "user-2")).rejects.toBeInstanceOf(
      InvitationAccountMismatchError,
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("an expired invitation is refused and marked expired", async () => {
    mocks.findInvitation.mockResolvedValue({
      ...pendingInvitation,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(acceptInvitation(INVITATION_ID, "user-1")).rejects.toMatchObject({
      name: "InvitationAcceptError",
      code: "expired",
    });
    expect(mocks.updateInvitation).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { status: "EXPIRED" },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", null, "invalid"],
    ["already accepted", { ...pendingInvitation, status: "ACCEPTED" }, "invalid"],
    ["revoked", { ...pendingInvitation, status: "REVOKED" }, "invalid"],
    ["already expired", { ...pendingInvitation, status: "EXPIRED" }, "expired"],
  ])("an %s invitation is refused with a fixed code", async (_label, invitation, code) => {
    mocks.findInvitation.mockResolvedValue(invitation);

    await expect(acceptInvitation(INVITATION_ID, "user-1")).rejects.toMatchObject({
      name: "InvitationAcceptError",
      code,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
