import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MembersModule from "@/server/services/members";

/**
 * Who may accept an invitation is decided by the signed-in session's email
 * (Supabase Auth), never by the copy in `public.users.email`: a signed-in
 * user can update their own `public.users` row, so a second account could
 * otherwise be given the invitee's address and accept an invitation whose
 * token a member of the organization can read.
 *
 * Synthetic data only. The service is the real one over an in-memory fake;
 * the fake's `public.users` row always carries an email, so a decision made
 * from it would show up here.
 */

type Row = Record<string, unknown>;

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "3f0c2b9e-8a41-4d2e-9b7c-1e5f6a7b8c9d";
const INVITED = "invitee@example.test";

const s = vi.hoisted(() => ({
  invitation: {} as Record<string, unknown>,
  members: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  // public.users.email by user id: the user-writable copy.
  profileEmails: new Map<string, string>(),
}));
const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  refreshSession: vi.fn(async () => ({})),
  updateUserById: vi.fn(async () => ({})),
}));

const tx = {
  invitation: {
    findUnique: vi.fn(async () => ({ status: s.invitation.status })),
    update: vi.fn(async ({ data }: { data: Row }) => Object.assign(s.invitation, data)),
  },
  organization: { findUnique: vi.fn(async () => ({ deletedAt: null })) },
  organizationMember: {
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        s.members.find(
          (m) => m.organizationId === where.organizationId && m.userId === where.userId,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      s.members.push(data);
      return data;
    }),
  },
  bookingType: { updateMany: vi.fn(async () => ({ count: 0 })) },
  auditLog: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      s.audits.push(data);
      return data;
    }),
  },
};

const db = {
  invitation: {
    findUnique: vi.fn(async ({ where }: { where: Row }) =>
      where.token === s.invitation.token ? { ...s.invitation } : null,
    ),
    update: vi.fn(async () => ({})),
  },
  user: {
    // Returns the whole row whatever is selected, email included.
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => ({
      id: where.id,
      email: s.profileEmails.get(where.id as string) ?? `${where.id as string}@example.test`,
    })),
  },
  $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
};

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/env", () => ({
  getAppUrlEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.example.test" }),
}));
vi.mock("@/server/auth/session", () => ({
  getSessionUser: mocks.getSessionUser,
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/server/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/server/security/rate-limit", () => ({
  actionRateLimitError: vi.fn(async () => null),
  actionWriteLimitError: vi.fn(async () => null),
  emailKey: (email: string) => email,
}));
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
  tenantDb: () => {
    throw new Error("tenantDb is not used by acceptInvitation");
  },
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServer: async () => ({ auth: { refreshSession: mocks.refreshSession } }),
  createSupabaseAdmin: () => ({ auth: { admin: { updateUserById: mocks.updateUserById } } }),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(),
  getEntitlements: vi.fn(async () => ({ maxSeats: 10, readOnly: false })),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/billing/seats", () => ({
  lockOrgSeats: vi.fn(async () => undefined),
  countActiveSeats: vi.fn(async () => s.members.length),
}));
vi.mock("@/server/services/audit", () => ({
  audit: vi.fn(),
  auditLogData: vi.fn(async (ctx: { orgId: string; userId: string }, input: Row) => ({
    organizationId: ctx.orgId,
    actorId: ctx.userId,
    ...input,
  })),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: () => null }));
// The real service, observed: the action tests below see exactly what the
// action hands it, and it still decides the outcome.
vi.mock("@/server/services/members", async (importActual) => {
  const actual = await importActual<typeof MembersModule>();
  return { ...actual, acceptInvitation: vi.fn(actual.acceptInvitation) };
});

import { acceptInvitation, InvitationAccountMismatchError } from "@/server/services/members";
import { acceptInvitationAction } from "@/actions/members";

/** Nothing was written and the join's transaction was never opened. */
function expectNothingJoined() {
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(s.members).toHaveLength(0);
  expect(s.audits).toHaveLength(0);
  expect(s.invitation.status).toBe("PENDING");
  expect(db.invitation.update).not.toHaveBeenCalled();
  expect(mocks.updateUserById).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  s.invitation = {
    id: "inv-1",
    organizationId: ORG,
    email: INVITED,
    role: "ADMIN",
    token: TOKEN,
    status: "PENDING",
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  s.members = [];
  s.audits = [];
  s.profileEmails = new Map();
});

describe("acceptInvitation decides by the session's email", () => {
  it("public.users.email set to the invited address, session email different: mismatch, nothing written", async () => {
    s.profileEmails.set("attacker", INVITED);

    await expect(
      acceptInvitation(TOKEN, { id: "attacker", email: "attacker@example.test" }),
    ).rejects.toBeInstanceOf(InvitationAccountMismatchError);

    expectNothingJoined();
  });

  it("public.users.email stale or different, session email is the invited one: accepted", async () => {
    s.profileEmails.set("invitee-id", "an-old-address@example.test");

    await expect(acceptInvitation(TOKEN, { id: "invitee-id", email: INVITED })).resolves.toBe(ORG);

    expect(s.members).toEqual([{ organizationId: ORG, userId: "invitee-id", role: "ADMIN" }]);
    expect(s.invitation.status).toBe("ACCEPTED");
    expect(s.audits).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        actorId: "invitee-id",
        action: "member.join",
        resourceId: "invitee-id",
      }),
    ]);
    expect(mocks.updateUserById).toHaveBeenCalledWith("invitee-id", {
      app_metadata: { last_active_org: ORG },
    });
  });

  it.each([
    ["session in other letter case", "Invitee@Example.TEST", INVITED],
    ["invitation in other letter case", INVITED, "Invitee@Example.TEST"],
  ])("%s is the invited account", async (_label, sessionEmail, invitedEmail) => {
    s.invitation.email = invitedEmail;

    await expect(acceptInvitation(TOKEN, { id: "invitee-id", email: sessionEmail })).resolves.toBe(
      ORG,
    );
    expect(s.members).toHaveLength(1);
  });

  it.each([[undefined], [null], [""]])(
    "a session without an email (%j) is a mismatch, even when public.users.email matches",
    async (email) => {
      s.profileEmails.set("no-email", INVITED);

      await expect(acceptInvitation(TOKEN, { id: "no-email", email })).rejects.toBeInstanceOf(
        InvitationAccountMismatchError,
      );

      expectNothingJoined();
    },
  );

  it("a near miss is not the invited account", async () => {
    await expect(
      acceptInvitation(TOKEN, { id: "other", email: `x${INVITED}` }),
    ).rejects.toBeInstanceOf(InvitationAccountMismatchError);
    await expect(
      acceptInvitation(TOKEN, { id: "other", email: `${INVITED}.evil.test` }),
    ).rejects.toBeInstanceOf(InvitationAccountMismatchError);

    expectNothingJoined();
  });
});

describe("acceptInvitationAction passes the session identity", () => {
  it("the service gets the session's id and email and nothing else; the client supplies only token and locale", async () => {
    mocks.getSessionUser.mockResolvedValue({
      id: "invitee-id",
      email: INVITED,
      // Present on a real session user; none of it is forwarded.
      user_metadata: { email: "someone-else@example.test" },
      app_metadata: { last_active_org: "other-org" },
    });

    await expect(acceptInvitationAction(TOKEN, "en")).rejects.toThrow(
      "NEXT_REDIRECT:/en/dashboard",
    );

    expect(acceptInvitation).toHaveBeenCalledTimes(1);
    expect(acceptInvitation).toHaveBeenCalledWith(TOKEN, { id: "invitee-id", email: INVITED });
    expect(s.members).toEqual([{ organizationId: ORG, userId: "invitee-id", role: "ADMIN" }]);
    expect(mocks.refreshSession).toHaveBeenCalledOnce();
  });

  it("another account whose public.users.email and user_metadata name the invited address: back to the invitation, nothing written", async () => {
    s.profileEmails.set("attacker", INVITED);
    mocks.getSessionUser.mockResolvedValue({
      id: "attacker",
      email: "attacker@example.test",
      // Editable by the user through Supabase Auth; never an identity.
      user_metadata: { email: INVITED },
    });

    await expect(acceptInvitationAction(TOKEN, "en")).rejects.toThrow(
      `NEXT_REDIRECT:/en/invite/${TOKEN}`,
    );

    expect(acceptInvitation).toHaveBeenCalledWith(TOKEN, {
      id: "attacker",
      email: "attacker@example.test",
    });
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith(`/en/invite/${TOKEN}`);
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expectNothingJoined();
  });

  it("a session without an email can't accept", async () => {
    s.profileEmails.set("no-email", INVITED);
    mocks.getSessionUser.mockResolvedValue({ id: "no-email" });

    await expect(acceptInvitationAction(TOKEN, "en")).rejects.toThrow(
      `NEXT_REDIRECT:/en/invite/${TOKEN}`,
    );

    expect(acceptInvitation).toHaveBeenCalledWith(TOKEN, { id: "no-email", email: undefined });
    expectNothingJoined();
  });

  it("signed out: refused before the service is reached", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    await expect(acceptInvitationAction(TOKEN, "en")).rejects.toThrow("Not authenticated");

    expect(acceptInvitation).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expectNothingJoined();
  });
});
