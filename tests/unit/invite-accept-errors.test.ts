import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * An acceptance that fails for an expected reason (invalid, expired, seat
 * limit, read-only workspace, already a member) returns to the localized
 * invitation page with a fixed, allowlisted code, which the page turns into a
 * translated message. Only the code crosses: never seat counts, plan details,
 * exception text or anything about the organization. Unknown failures still
 * fail, and the framework's own redirects are never swallowed.
 */

const INVITATION_ID = "3f0c2b9e-8a41-4d2e-9b7c-1e5f6a7b8c9d";
const CODES = ["invalid", "expired", "seat_limit", "read_only", "already_member"] as const;

const mocks = vi.hoisted(() => {
  class InvitationAccountMismatchError extends Error {}
  class InvitationAcceptError extends Error {
    constructor(readonly code: string) {
      super(`Invitation can't be accepted: ${code}`);
    }
  }
  return {
    locale: "en",
    InvitationAccountMismatchError,
    InvitationAcceptError,
    redirect: vi.fn((path: string) => {
      throw Object.assign(new Error(`NEXT_REDIRECT:${path}`), { digest: "NEXT_REDIRECT" });
    }),
    getSessionUser: vi.fn(),
    findInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    refreshSession: vi.fn(async () => ({})),
  };
});

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale: mocks.locale,
        messages: JSON.parse(
          fs.readFileSync(path.resolve(__dirname, `../../messages/${mocks.locale}.json`), "utf8"),
        ),
        namespace,
      }),
  };
});
vi.mock("@/server/integrations/redis", () => ({ rateLimiters: {} }));
vi.mock("@/server/auth/session", () => ({
  getSessionUser: mocks.getSessionUser,
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/server/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: { invitation: { findUnique: mocks.findInvitation } },
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServer: async () => ({ auth: { refreshSession: mocks.refreshSession } }),
  createSupabaseAdmin: vi.fn(),
}));
vi.mock("@/server/services/members", () => ({
  InvitationAccountMismatchError: mocks.InvitationAccountMismatchError,
  InvitationAcceptError: mocks.InvitationAcceptError,
  MemberError: class MemberError extends Error {},
  acceptInvitation: mocks.acceptInvitation,
  inviteMember: vi.fn(),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: class EntitlementError extends Error {},
}));

import InvitePage from "@/app/[locale]/(auth)/invite/[token]/page";
import { acceptInvitationAction } from "@/actions/members";
import { INVITATION_ACCEPT_ERROR_CODES, parseInvitationAcceptError } from "@/lib/invitation-errors";

const pendingInvitation = {
  id: "inv-1",
  email: "invitee@example.test",
  role: "MEMBER",
  token: INVITATION_ID,
  status: "PENDING",
  expiresAt: new Date(Date.now() + 86_400_000),
  organization: { name: "Synthetic Org" },
};

async function renderWithError(error: unknown, locale = "en"): Promise<string> {
  mocks.locale = locale;
  mocks.findInvitation.mockResolvedValue(pendingInvitation);
  mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "invitee@example.test" });
  const element = await InvitePage({
    params: Promise.resolve({ locale, token: INVITATION_ID }),
    searchParams: Promise.resolve({ error } as { error?: string }),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "invitee@example.test" });
});

describe("the error codes", () => {
  it("are exactly the reviewed set", () => {
    expect([...INVITATION_ACCEPT_ERROR_CODES]).toEqual([...CODES]);
  });

  it.each(CODES)("%s is accepted", (code) => {
    expect(parseInvitationAcceptError(code)).toBe(code);
  });

  it.each([
    "unknown",
    "INVALID",
    "seat_limit ",
    "Seat limit reached for your plan.",
    "<script>",
    "",
    ["invalid"],
    undefined,
    null,
    42,
  ])("%j is rejected", (value) => {
    expect(parseInvitationAcceptError(value)).toBeNull();
  });
});

describe("acceptInvitationAction", () => {
  it.each(CODES)("%s: back to the localized invitation page with only the code", async (code) => {
    mocks.acceptInvitation.mockRejectedValue(new mocks.InvitationAcceptError(code));

    await expect(acceptInvitationAction(INVITATION_ID, "fi")).rejects.toThrow(
      `NEXT_REDIRECT:/fi/invite/${INVITATION_ID}?error=${code}`,
    );
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("an unknown locale falls back to the default locale", async () => {
    mocks.acceptInvitation.mockRejectedValue(new mocks.InvitationAcceptError("expired"));

    await expect(acceptInvitationAction(INVITATION_ID, "//evil.example")).rejects.toThrow(
      `NEXT_REDIRECT:/fi/invite/${INVITATION_ID}?error=expired`,
    );
  });

  it("a token that isn't one never builds an invitation URL", async () => {
    mocks.acceptInvitation.mockRejectedValue(new mocks.InvitationAcceptError("invalid"));

    await expect(acceptInvitationAction("../../evil", "en")).rejects.toThrow(
      "NEXT_REDIRECT:/en/dashboard",
    );
  });

  it("success: joins, refreshes the session and goes to the localized dashboard", async () => {
    mocks.acceptInvitation.mockResolvedValue("org-1");

    await expect(acceptInvitationAction(INVITATION_ID, "ar")).rejects.toThrow(
      "NEXT_REDIRECT:/ar/dashboard",
    );
    expect(mocks.acceptInvitation).toHaveBeenCalledWith(INVITATION_ID, "user-1");
    expect(mocks.refreshSession).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it("a framework redirect thrown inside acceptInvitation propagates untouched", async () => {
    const frameworkRedirect = Object.assign(new Error("NEXT_REDIRECT:/elsewhere"), {
      digest: "NEXT_REDIRECT;replace;/elsewhere;307;",
    });
    mocks.acceptInvitation.mockRejectedValue(frameworkRedirect);

    await expect(acceptInvitationAction(INVITATION_ID, "en")).rejects.toBe(frameworkRedirect);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each([
    ["a database error", new Error("connection reset: host db.internal")],
    ["a non-Error throw", "boom"],
  ])("%s is rethrown, never turned into an error code", async (_label, err) => {
    mocks.acceptInvitation.mockRejectedValue(err);

    await expect(acceptInvitationAction(INVITATION_ID, "en")).rejects.toBe(err);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });
});

describe("the invitation page shows a known error code", () => {
  it.each([
    ["invalid", "This invitation is no longer valid."],
    ["expired", "This invitation has expired."],
    ["seat_limit", "Contact a workspace admin."],
    ["read_only", "Contact a workspace admin."],
    ["already_member", "already a member of this workspace"],
  ])("%s, in English", async (code, text) => {
    const html = await renderWithError(code);

    expect(html).toContain(text);
    expect(html).toContain('role="alert"');
    // Nothing about the organization, and no way to retry from here.
    expect(html).not.toContain("Synthetic Org");
    expect(html).not.toContain("invitee@example.test");
    expect(html).not.toContain("Accept invitation");
    expect(mocks.findInvitation).not.toHaveBeenCalled();
  });

  it("already_member offers the localized dashboard; the others don't", async () => {
    expect(await renderWithError("already_member", "en")).toContain('href="/en/dashboard"');
    for (const code of ["invalid", "expired", "seat_limit", "read_only"]) {
      expect(await renderWithError(code, "en")).not.toContain("/dashboard");
    }
  });

  it("Finnish", async () => {
    const seat = await renderWithError("seat_limit", "fi");
    expect(seat).toContain("Ota yhteyttä työtilan ylläpitäjään.");
    const member = await renderWithError("already_member", "fi");
    expect(member).toContain("Olet jo tämän työtilan jäsen.");
    expect(member).toContain('href="/fi/dashboard"');
    expect(member).toContain("Siirry hallintapaneeliin");
  });

  it("Arabic", async () => {
    const expired = await renderWithError("expired", "ar");
    expect(expired).toContain("انتهت صلاحية هذه الدعوة.");
    const member = await renderWithError("already_member", "ar");
    expect(member).toContain("أنت عضو بالفعل في مساحة العمل هذه.");
    expect(member).toContain('href="/ar/dashboard"');
  });

  it.each(["unknown", "Seat limit reached for your plan.", "<script>alert(1)</script>"])(
    "an unknown code (%j) is ignored and the normal invitation renders",
    async (error) => {
      const html = await renderWithError(error);

      expect(html).toContain("Accept invitation");
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain("Seat limit reached");
    },
  );
});
