import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Withdrawing a pending invitation (revokeInvitation / revokeInvitationAction):
 * the seat is freed, the link dies, the token is replaced so a later re-invite
 * can't revive it, only the organization's own invitations are reachable, and
 * the write happens under the organization's seat lock, inside one transaction,
 * as a conditional update. The real service, action, rate-limit helpers and
 * seat-lock helper run over a fake database and a fake Upstash; the
 * accept-vs-withdraw interleavings themselves are in
 * invitation-seat-limit.test.ts (lock fake) and
 * invitation-accept-revoke.postgres.test.ts (real Postgres).
 */

type Invitation = {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  token: string;
};
type Row = Record<string, unknown>;

const s = vi.hoisted(() => ({
  invitations: [] as Invitation[],
  // Every database step in order: "tx", "lock:<orgId>", "read", "write".
  steps: [] as string[],
  beforeWrite: null as null | (() => void),
  writeFailure: null as Error | null,
  ctx: {
    orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "OWNER",
  } as Record<string, string> | null,
  // The fake Upstash.
  mode: "ok" as "ok" | "timeout" | "throw",
  counts: new Map<string, number>(),
  keys: [] as string[],
}));

const fx = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  revalidatePath: vi.fn(),
  consoleError: vi.fn(),
  requirePermission: vi.fn(async (permission: string) => {
    // Only the permission the action is specified to require is granted; a
    // request for any other one is refused, so the test proves which was asked.
    if (!s.ctx) throw new Error("Missing permission");
    if (permission !== "members:invite") throw new Error(`Unexpected permission: ${permission}`);
    return s.ctx;
  }),
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "22222222-2222-4222-8222-222222222222";

const matches = (row: Invitation, where: Row) =>
  Object.entries(where).every(([k, v]) => v === undefined || row[k as keyof Invitation] === v);

const tx = {
  // lockOrgSeats: pg_advisory_xact_lock(hashtext(orgId), 3)
  $executeRaw: vi.fn(async (_sql: TemplateStringsArray, orgId: string) => {
    s.steps.push(`lock:${orgId}`);
    return 0;
  }),
  invitation: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      s.steps.push("read");
      const row = s.invitations.find((i) => matches(i, where));
      return row ? { id: row.id, email: row.email, role: row.role } : null;
    }),
    // Like Prisma: a filter that isn't given matches every row.
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      s.steps.push("write");
      if (s.writeFailure) throw s.writeFailure;
      s.beforeWrite?.();
      const rows = s.invitations.filter((i) => matches(i, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    }),
  },
};

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: fx.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ getSessionUser: vi.fn(), AuthError: Error }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: fx.requirePermission }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: vi.fn(),
  createSupabaseServer: vi.fn(),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(),
  getEntitlements: vi.fn(),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("../../emails/invitation", () => ({ InvitationEmail: vi.fn() }));
vi.mock("@/env", async (importActual) => ({
  ...(await importActual<object>()),
  getAppUrlEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));
vi.mock("@/server/services/audit", () => ({ audit: fx.audit }));
vi.mock("@/lib/auth-redirect", () => ({
  inviteContinuation: vi.fn(),
  localizedPath: vi.fn(),
  normalizeLocale: vi.fn(),
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      s.steps.push("tx");
      return fn(tx);
    }),
  },
  tenantDb: () => {
    throw new Error("revokeInvitation runs inside one transaction");
  },
}));
// The real rate-limit helpers over a fake Upstash that counts calls per
// limiter prefix and key (as in rate-limit-write-actions.test.ts).
vi.mock("@upstash/redis", () => ({ Redis: class Redis {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class Ratelimit {
    static slidingWindow(max: number) {
      return { max };
    }
    private readonly prefix: string;
    private readonly max: number;
    constructor(opts: { prefix: string; limiter: { max: number } }) {
      this.prefix = opts.prefix;
      this.max = opts.limiter.max;
    }
    async limit(key: string) {
      if (s.mode === "throw") throw new Error("fetch failed");
      if (s.mode === "timeout") {
        return { success: true, reason: "timeout", limit: 0, remaining: 0, reset: 0 };
      }
      const id = `${this.prefix}|${key}`;
      s.keys.push(id);
      const used = (s.counts.get(id) ?? 0) + 1;
      s.counts.set(id, used);
      return {
        success: used <= this.max,
        limit: this.max,
        remaining: Math.max(0, this.max - used),
        reset: Date.now() + 60_000,
      };
    }
  },
}));

import { MemberError, revokeInvitation } from "@/server/services/members";
import { revokeInvitationAction } from "@/actions/members";
import type { TenantContext } from "@/server/auth/session";

const ctx = { orgId: ORG_A, userId: USER, role: "OWNER" } as unknown as TenantContext;
const OLD_TOKEN = "3f2b8c1e-9a4d-4c7b-8e2f-000000000001";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const API_LIMIT = 100;
const WRITE_KEY = `rl:api|members-write:${ORG_A}:${USER}`;

const row = (id: string) => s.invitations.find((i) => i.id === id)!;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  s.mode = "ok";
  s.counts.clear();
  s.keys.length = 0;
  s.steps.length = 0;
  s.beforeWrite = null;
  s.writeFailure = null;
  s.ctx = { orgId: ORG_A, userId: USER, role: "OWNER" };
  s.invitations = [
    {
      id: "inv-a",
      organizationId: ORG_A,
      email: "typo@example.test",
      role: "MEMBER",
      status: "PENDING",
      token: OLD_TOKEN,
    },
    {
      id: "inv-accepted",
      organizationId: ORG_A,
      email: "joined@example.test",
      role: "ADMIN",
      status: "ACCEPTED",
      token: "3f2b8c1e-9a4d-4c7b-8e2f-000000000002",
    },
    {
      id: "inv-b",
      organizationId: ORG_B,
      email: "other-org@example.test",
      role: "MEMBER",
      status: "PENDING",
      token: "3f2b8c1e-9a4d-4c7b-8e2f-000000000003",
    },
  ];
  for (const mock of Object.values(fx)) mock.mockClear();
  vi.spyOn(console, "error").mockImplementation(fx.consoleError);
});

describe("revokeInvitation", () => {
  it("marks a pending invitation REVOKED and replaces its token", async () => {
    await revokeInvitation(ctx, "inv-a");
    expect(row("inv-a").status).toBe("REVOKED");
    expect(row("inv-a").token).not.toBe(OLD_TOKEN);
    expect(row("inv-a").token).toMatch(UUID_V4);
  });

  it("takes the organization's seat lock inside the transaction, before reading, then writes once", async () => {
    await revokeInvitation(ctx, "inv-a");
    expect(s.steps).toEqual(["tx", `lock:${ORG_A}`, "read", "write"]);
    expect(tx.$executeRaw.mock.calls[0]![0].join("?")).toContain("pg_advisory_xact_lock");
  });

  it("writes one audit row naming the invitation, never a token", async () => {
    await revokeInvitation(ctx, "inv-a");
    expect(fx.audit).toHaveBeenCalledTimes(1);
    const [auditCtx, entry] = fx.audit.mock.calls[0] as unknown as [typeof ctx, Row];
    expect(auditCtx).toEqual(ctx);
    expect(entry).toMatchObject({
      action: "member.invite_revoke",
      resourceType: "invitation",
      resourceId: "inv-a",
      before: { email: "typo@example.test", role: "MEMBER", status: "PENDING" },
      after: { status: "REVOKED" },
    });
    expect(JSON.stringify(entry)).not.toContain(OLD_TOKEN);
  });

  it("cannot reach another organization's invitation", async () => {
    await expect(revokeInvitation(ctx, "inv-b")).rejects.toMatchObject({ code: "not_pending" });
    expect(row("inv-b").status).toBe("PENDING");
    expect(s.steps).not.toContain("write");
    expect(fx.audit).not.toHaveBeenCalled();
  });

  it("refuses an invitation that is no longer pending, and an unknown id", async () => {
    await expect(revokeInvitation(ctx, "inv-accepted")).rejects.toBeInstanceOf(MemberError);
    await expect(revokeInvitation(ctx, "missing")).rejects.toMatchObject({ code: "not_pending" });
    expect(row("inv-accepted").status).toBe("ACCEPTED");
    expect(fx.audit).not.toHaveBeenCalled();
  });

  it("an invitation accepted between the read and the write is refused, not re-written", async () => {
    s.beforeWrite = () => {
      row("inv-a").status = "ACCEPTED";
    };
    await expect(revokeInvitation(ctx, "inv-a")).rejects.toMatchObject({ code: "not_pending" });
    expect(row("inv-a").status).toBe("ACCEPTED");
    expect(row("inv-a").token).toBe(OLD_TOKEN);
    expect(fx.audit).not.toHaveBeenCalled();
  });
});

describe("revokeInvitationAction", () => {
  it("success: revoked, and the members page is revalidated", async () => {
    expect(await revokeInvitationAction("inv-a")).toEqual({ message: "revoked" });
    expect(fx.revalidatePath).toHaveBeenCalledWith("/settings/members");
  });

  it("a stable code for an invitation that isn't pending", async () => {
    expect(await revokeInvitationAction("inv-accepted")).toEqual({ error: "not_pending" });
    expect(fx.revalidatePath).not.toHaveBeenCalled();
  });

  it("an unexpected failure becomes revoke_failed and logs only the error's name", async () => {
    s.writeFailure = new Error("connection refused: db-host-with-secret");
    expect(await revokeInvitationAction("inv-a")).toEqual({ error: "revoke_failed" });
    const logged = fx.consoleError.mock.calls.flat().join(" ");
    expect(logged).toContain('"event":"revoke_invitation_failed"');
    expect(logged).not.toContain("db-host-with-secret");
  });

  it("requires exactly members:invite, before touching anything", async () => {
    await revokeInvitationAction("inv-a");
    expect(fx.requirePermission).toHaveBeenCalledTimes(1);
    expect(fx.requirePermission).toHaveBeenCalledWith("members:invite");

    s.ctx = null;
    s.steps.length = 0;
    s.keys.length = 0;
    await expect(revokeInvitationAction("inv-accepted")).rejects.toThrow("Missing permission");
    expect(s.steps).toEqual([]);
    expect(s.keys).toEqual([]);
  });
});

describe("revokeInvitationAction shares the members write limit", () => {
  it("counts on the api limiter under a key of area, organization and user only", async () => {
    await revokeInvitationAction("inv-a");
    expect(s.keys).toEqual([WRITE_KEY]);
  });

  it("the 101st write in a minute is refused as rate_limited and changes nothing", async () => {
    for (let i = 0; i < API_LIMIT; i++) await revokeInvitationAction("inv-accepted");
    s.steps.length = 0;
    expect(await revokeInvitationAction("inv-a")).toEqual({ error: "rate_limited" });
    expect(row("inv-a").status).toBe("PENDING");
    expect(row("inv-a").token).toBe(OLD_TOKEN);
    expect(s.steps).toEqual([]);
    expect(fx.audit).not.toHaveBeenCalled();
  });

  it("is per user and per organization", async () => {
    for (let i = 0; i < API_LIMIT; i++) await revokeInvitationAction("inv-accepted");
    s.ctx = { orgId: ORG_A, userId: "33333333-3333-4333-8333-333333333333", role: "ADMIN" };
    expect(await revokeInvitationAction("inv-accepted")).toEqual({ error: "not_pending" });
    s.ctx = { orgId: ORG_B, userId: USER, role: "OWNER" };
    expect(await revokeInvitationAction("inv-b")).toEqual({ message: "revoked" });
  });

  it("fails closed: a Redis timeout or error refuses with service_unavailable and changes nothing", async () => {
    s.mode = "timeout";
    expect(await revokeInvitationAction("inv-a")).toEqual({ error: "service_unavailable" });
    s.mode = "throw";
    expect(await revokeInvitationAction("inv-a")).toEqual({ error: "service_unavailable" });
    expect(row("inv-a").status).toBe("PENDING");
    expect(s.steps).toEqual([]);
  });
});
