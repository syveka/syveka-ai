import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * An invitation opened in a browser signed in to another account (DENOVA
 * pilot, 2026-10-13: Accept returned 500 "Invitation was sent to a different
 * email address" and the person saw only "Something went wrong"). The page
 * says whose invitation it is and offers to sign out; Accept is never offered
 * to the wrong account, and a mismatch on Accept returns to the invitation
 * instead of an error page. "Switch account" signs out instead of linking to
 * /login, which sends a signed-in person to the dashboard.
 */

const INVITATION_ID = "3f0c2b9e-8a41-4d2e-9b7c-1e5f6a7b8c9d";

const mocks = vi.hoisted(() => {
  class InvitationAccountMismatchError extends Error {}
  return {
    locale: "en",
    InvitationAccountMismatchError,
    redirect: vi.fn((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    }),
    getSessionUser: vi.fn(),
    findInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    signOut: vi.fn(async () => ({ error: null })),
    refreshSession: vi.fn(async () => ({})),
  };
});

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
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
  createSupabaseServer: async () => ({
    auth: { signOut: mocks.signOut, refreshSession: mocks.refreshSession },
  }),
  createSupabaseAdmin: vi.fn(),
}));
vi.mock("@/server/services/members", () => ({
  InvitationAccountMismatchError: mocks.InvitationAccountMismatchError,
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
import { signOutToInvitationAction } from "@/actions/auth";

const pendingInvitation = {
  id: "inv-1",
  email: "invitee@example.test",
  role: "MEMBER",
  token: INVITATION_ID,
  status: "PENDING",
  expiresAt: new Date(Date.now() + 86_400_000),
  organization: { name: "Synthetic Org" },
};

async function renderInvite(sessionEmail: string, locale = "en"): Promise<string> {
  mocks.locale = locale;
  mocks.findInvitation.mockResolvedValue(pendingInvitation);
  mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: sessionEmail });
  const element = await InvitePage({
    params: Promise.resolve({ locale, token: INVITATION_ID }),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("invitation page signed in to another account", () => {
  it("names both addresses and offers sign-out, not Accept", async () => {
    const html = await renderInvite("someone-else@example.test");

    expect(html).toContain("invitee@example.test");
    expect(html).toContain("someone-else@example.test");
    expect(html).toContain("Sign out and continue");
    expect(html).not.toContain("Accept invitation");
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
  });

  it("the invited address in other letter case is the invited account", async () => {
    const html = await renderInvite("Invitee@Example.TEST");

    expect(html).toContain("Accept invitation");
    expect(html).not.toContain("Sign out and continue");
  });

  it("the invited account sees Accept, and Switch account no longer links to /login", async () => {
    const html = await renderInvite("invitee@example.test");

    expect(html).toContain("Accept invitation");
    expect(html).toContain("Switch account");
    expect(html).not.toContain('href="/login"');
  });
});

describe("accepting as another account", () => {
  it("returns to the invitation instead of an error page", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user-2", email: "someone-else@example.test" });
    mocks.acceptInvitation.mockRejectedValue(new mocks.InvitationAccountMismatchError());

    await expect(acceptInvitationAction(INVITATION_ID, "ar")).rejects.toThrow(
      `NEXT_REDIRECT:/ar/invite/${INVITATION_ID}`,
    );
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("any other failure still fails", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "invitee@example.test" });
    mocks.acceptInvitation.mockRejectedValue(new Error("Invalid invitation"));

    await expect(acceptInvitationAction(INVITATION_ID, "en")).rejects.toThrow("Invalid invitation");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each(["fi", "en", "ar"])(
    "the invited account joins and goes to the dashboard in the page's language (%s)",
    async (locale) => {
      mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "invitee@example.test" });
      mocks.acceptInvitation.mockResolvedValue("org-1");

      await expect(acceptInvitationAction(INVITATION_ID, locale)).rejects.toThrow(
        `NEXT_REDIRECT:/${locale}/dashboard`,
      );
      expect(mocks.acceptInvitation).toHaveBeenCalledWith(INVITATION_ID, "user-1");
      expect(mocks.refreshSession).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, "xx", "//evil.example", "../en"])(
    "a missing or unknown locale (%j) falls back to the default locale",
    async (locale) => {
      mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "invitee@example.test" });
      mocks.acceptInvitation.mockResolvedValue("org-1");

      await expect(acceptInvitationAction(INVITATION_ID, locale)).rejects.toThrow(
        "NEXT_REDIRECT:/fi/dashboard",
      );
    },
  );
});

describe("signing out to the invitation", () => {
  it.each(["fi", "en", "ar"])(
    "signs out, then returns to the invitation in the page's language (%s)",
    async (locale) => {
      await expect(signOutToInvitationAction(INVITATION_ID, locale)).rejects.toThrow(
        `NEXT_REDIRECT:/${locale}/invite/${INVITATION_ID}`,
      );
      expect(mocks.signOut).toHaveBeenCalledOnce();
      expect(mocks.signOut.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.redirect.mock.invocationCallOrder[0]!,
      );
    },
  );

  it.each([undefined, "xx", "//evil.example"])(
    "a missing or unknown locale (%j) falls back to the default locale",
    async (locale) => {
      await expect(signOutToInvitationAction(INVITATION_ID, locale)).rejects.toThrow(
        `NEXT_REDIRECT:/fi/invite/${INVITATION_ID}`,
      );
    },
  );

  it.each(["not-a-token", `${INVITATION_ID}/../../dashboard`, "//evil.example"])(
    "a token that isn't one (%j) goes to the login page",
    async (token) => {
      await expect(signOutToInvitationAction(token, "en")).rejects.toThrow(
        "NEXT_REDIRECT:/en/login",
      );
      expect(mocks.signOut).toHaveBeenCalledOnce();
    },
  );
});

describe("invitation page language", () => {
  it("Finnish: the page and the role are in Finnish", async () => {
    const html = await renderInvite("invitee@example.test", "fi");

    expect(html).toContain("Liity organisaatioon Synthetic Org");
    expect(html).toContain("Jäsen");
    expect(html).toContain("Hyväksy kutsu");
    expect(html).not.toContain("MEMBER");
  });

  it("Arabic: the other-account notice keeps each address in its own direction", async () => {
    const html = await renderInvite("someone-else@example.test", "ar");

    expect(html).toContain('<strong dir="auto">invitee@example.test</strong>');
    expect(html).toContain('<strong dir="auto">someone-else@example.test</strong>');
    expect(html).toContain("تسجيل الخروج والمتابعة");
  });

  it("an invalid invitation is reported in the page's language", async () => {
    mocks.locale = "fi";
    mocks.findInvitation.mockResolvedValue(null);
    const element = await InvitePage({
      params: Promise.resolve({ locale: "fi", token: INVITATION_ID }),
    });

    expect(renderToStaticMarkup(element)).toContain("Kutsu on virheellinen tai vanhentunut.");
  });
});
