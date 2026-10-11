import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rate limits on the writes that send email, fan out to providers or queues, or
 * cost money: invitations, Business DNA service changes (each re-syncs the
 * voice assistants), Creator Studio post workflow steps, the server actions
 * that mirror rate-limited routes, and paid generations (now failing closed on
 * a Redis timeout as well as an error).
 *
 * The real helpers (checkRateLimit → rateLimitRefusal / actionRateLimitError)
 * run against a fake Upstash that counts calls per limiter prefix and key, with
 * each limiter's configured maximum, so limits, shared allowances and
 * isolation between organizations behave as they do in production.
 */

const s = vi.hoisted(() => ({
  mode: "ok" as "ok" | "timeout" | "throw",
  counts: new Map<string, number>(),
  keys: [] as string[],
  ctx: { orgId: "org-a", userId: "user-1", role: "OWNER" } as Record<string, unknown> | null,
}));

const fx = vi.hoisted(() => ({
  inviteMember: vi.fn(async () => undefined),
  createService: vi.fn(async () => ({ id: "svc-1" })),
  updateService: vi.fn(async () => ({ id: "svc-1" })),
  deactivateService: vi.fn(async () => ({ id: "svc-1" })),
  reactivateService: vi.fn(async () => ({ id: "svc-1" })),
  upsertBusinessDNA: vi.fn(async () => ({ ok: true, record: {} })),
  schedulePost: vi.fn(async () => ({ id: "post-1" })),
  requestPostApproval: vi.fn(async () => ({ id: "post-1" })),
  reviewCreatorPost: vi.fn(async () => ({ id: "post-1" })),
  disconnectSocialAccount: vi.fn(async () => ({ id: "acct-1" })),
  createCreatorPost: vi.fn(async () => ({ id: "post-1" })),
  requestCaptionGeneration: vi.fn(async () => ({ generation: { id: "gen-1" } })),
}));

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
      // Upstash allows a request when Redis doesn't answer in time.
      if (s.mode === "timeout") {
        return { success: true, reason: "timeout", limit: 0, remaining: 0, reset: 0 };
      }
      const id = `${this.prefix}|${key}`;
      s.keys.push(id);
      const used = (s.counts.get(id) ?? 0) + 1;
      s.counts.set(id, used);
      const reset = Date.now() + 60_000;
      return {
        success: used <= this.max,
        limit: this.max,
        remaining: Math.max(0, this.max - used),
        reset,
      };
    }
  },
}));

const { AuthError } = vi.hoisted(() => ({
  AuthError: class AuthError extends Error {
    constructor(
      message: string,
      public readonly status = 403,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/server/auth/session", () => ({ AuthError, getSessionUser: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => {
    if (!s.ctx) throw new AuthError("Missing permission", 403);
    return s.ctx;
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/supabase/server", () => ({ createSupabaseServer: vi.fn() }));
vi.mock("@/server/services/members", () => ({
  inviteMember: fx.inviteMember,
  acceptInvitation: vi.fn(),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
  MemberError: class MemberError extends Error {},
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/business-dna-services", () => ({
  listBusinessDnaServices: vi.fn(async () => []),
  createBusinessDnaService: fx.createService,
  updateBusinessDnaService: fx.updateService,
  deactivateBusinessDnaService: fx.deactivateService,
  reactivateBusinessDnaService: fx.reactivateService,
}));
vi.mock("@/server/services/business-dna", () => ({
  upsertBusinessDNA: fx.upsertBusinessDNA,
  getBusinessDNA: vi.fn(),
}));
vi.mock("@/server/services/creator-posts", () => ({
  createCreatorPost: fx.createCreatorPost,
  updatePostContent: vi.fn(),
  requestPostApproval: fx.requestPostApproval,
  reviewCreatorPost: fx.reviewCreatorPost,
  schedulePost: fx.schedulePost,
  cancelScheduledPost: vi.fn(),
}));
vi.mock("@/server/services/creator-social-accounts", () => ({
  connectSocialAccount: vi.fn(),
  disconnectSocialAccount: fx.disconnectSocialAccount,
  startMetaOAuthUrl: vi.fn(),
  SocialConnectError: class SocialConnectError extends Error {},
}));
vi.mock("@/server/services/creator-generations", () => ({
  requestCharacterImageGeneration: vi.fn(),
  requestImageFromCharacterGeneration: vi.fn(),
  requestVideoFromImageGeneration: vi.fn(),
  requestCaptionGeneration: fx.requestCaptionGeneration,
}));
vi.mock("@/server/services/creator-profiles", () => ({
  createCreatorProfile: vi.fn(),
  createReferenceAssetUploadUrl: vi.fn(),
  confirmReferenceAsset: vi.fn(),
  confirmCreatorConsent: vi.fn(),
}));
vi.mock("@/server/services/creator-campaigns", () => ({
  createCreatorCampaign: vi.fn(),
  setCampaignAutopilot: vi.fn(),
}));
vi.mock("@/server/services/creator-studio-action-errors", () => ({
  creatorActionError: (_e: unknown, fallback: string) => fallback,
}));
vi.mock("@/server/services/creator-studio-http", async () => {
  const { NextResponse } = await import("next/server");
  return {
    handleCreatorStudioError: (e: unknown) =>
      e instanceof AuthError
        ? NextResponse.json({ error: { code: "forbidden" } }, { status: e.status })
        : NextResponse.json({ error: { code: "internal_error" } }, { status: 500 }),
  };
});

import { inviteMemberAction } from "@/actions/members";
import {
  createBusinessDnaServiceAction,
  deactivateBusinessDnaServiceAction,
} from "@/actions/business-dna-services";
import { updateBusinessDnaAction } from "@/actions/business-dna";
import {
  createCreatorPostAction,
  disconnectSocialAccountAction,
  generateCaptionAction,
  requestPostApprovalAction,
  reviewCreatorPostAction,
  schedulePostAction,
} from "@/actions/creator-studio";
import { POST as createServiceRoute } from "@/app/api/v1/business-dna/services/route";
import {
  PATCH as updateServiceRoute,
  DELETE as deleteServiceRoute,
} from "@/app/api/v1/business-dna/services/[id]/route";
import { PUT as saveProfileRoute } from "@/app/api/v1/business-dna/route";
import { POST as scheduleRoute } from "@/app/api/v1/creator-studio/posts/[id]/schedule/route";
import { POST as requestApprovalRoute } from "@/app/api/v1/creator-studio/posts/[id]/request-approval/route";
import { POST as reviewRoute } from "@/app/api/v1/creator-studio/posts/[id]/review/route";
import { POST as disconnectRoute } from "@/app/api/v1/creator-studio/social-accounts/[id]/disconnect/route";
import { POST as createPostRoute } from "@/app/api/v1/creator-studio/posts/route";
import { POST as captionRoute } from "@/app/api/v1/creator-studio/generations/caption/route";

const ORG_A = { orgId: "org-a", userId: "user-1", role: "OWNER" };
const ORG_B = { orgId: "org-b", userId: "user-9", role: "OWNER" };
const POST_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const inviteForm = (email: string) => {
  const form = new FormData();
  form.set("email", email);
  form.set("role", "MEMBER");
  return form;
};
const invite = (email: string) => inviteMemberAction({}, inviteForm(email));

const json = (body: unknown, method = "POST") =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (id = POST_ID) => ({ params: Promise.resolve({ id }) });
const scheduleBody = { scheduledFor: "2026-12-01T10:00:00Z", socialAccountId: ACCOUNT_ID };

/** Calls `run` until its limiter is exhausted, returning the last result. */
async function times<T>(n: number, run: () => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await run());
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  s.mode = "ok";
  s.counts.clear();
  s.keys = [];
  s.ctx = { ...ORG_A };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("invitations", () => {
  it("sends invitations under the limits", async () => {
    expect(await invite("new@example.test")).toEqual({ message: "invited" });
    expect(fx.inviteMember).toHaveBeenCalledTimes(1);
  });

  it("caps invitations to one address at 3 a day, without sending the 4th", async () => {
    const results = await times(4, () => invite("target@example.test"));
    expect(results.slice(0, 3)).toEqual(Array(3).fill({ message: "invited" }));
    expect(results[3]).toEqual({ error: "rate_limited" });
    expect(fx.inviteMember).toHaveBeenCalledTimes(3);
  });

  it("counts an address case- and whitespace-insensitively", async () => {
    await times(3, () => invite("Target@Example.test"));
    expect(await invite("target@example.test")).toEqual({ error: "rate_limited" });
  });

  it("caps an organization at 20 invitations an hour across addresses", async () => {
    const results = await times(21, async () => invite(`p${s.counts.size}@example.test`));
    expect(results.filter((r) => "message" in r)).toHaveLength(20);
    expect(results[20]).toEqual({ error: "rate_limited" });
    expect(fx.inviteMember).toHaveBeenCalledTimes(20);
  });

  it("another organization's allowance is its own", async () => {
    await times(4, () => invite("target@example.test"));
    s.ctx = { ...ORG_B };
    expect(await invite("target@example.test")).toEqual({ message: "invited" });
  });

  it("never stores the address in a limiter key", async () => {
    await invite("Private.Person@example.test");
    expect(s.keys.join(" ")).not.toMatch(/private|person|example/i);
  });

  it("answers the same whether or not the address has an account: decided before any lookup", async () => {
    await times(3, () => invite("target@example.test"));
    fx.inviteMember.mockClear();
    expect(await invite("target@example.test")).toEqual({ error: "rate_limited" });
    expect(fx.inviteMember).not.toHaveBeenCalled(); // no user/member lookup happened
  });

  it.each(["timeout", "throw"] as const)(
    "refuses without sending when the limit can't be verified (%s)",
    async (mode) => {
      s.mode = mode;
      expect(await invite("new@example.test")).toEqual({ error: "invite_failed" });
      expect(fx.inviteMember).not.toHaveBeenCalled();
    },
  );

  it("checks the permission before counting anything", async () => {
    s.ctx = null;
    await expect(invite("new@example.test")).rejects.toThrow("Missing permission");
    expect(s.keys).toHaveLength(0);
  });

  it("an invalid address is refused before counting", async () => {
    expect(await invite("not-an-email")).toEqual({ error: "invalid_input" });
    expect(s.keys).toHaveLength(0);
  });
});

describe("Business DNA service changes (each re-syncs the voice assistants)", () => {
  it("share the organization's 30-per-10-minutes save allowance with profile saves", async () => {
    await times(29, () => createServiceRoute(json({ name: "Cut", durationMinutes: 30 })));
    const formAction = await createBusinessDnaServiceAction({}, new FormData());
    expect(formAction.error).not.toBe("rate_limited"); // the 30th
    const res = await updateServiceRoute(json({ name: "Cut" }, "PATCH"), params());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: "rate_limited" } });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(fx.updateService).not.toHaveBeenCalled();
    expect((await updateBusinessDnaAction({}, new FormData())).error).toBe("rate_limited");
  });

  it("the form action reports rate_limited and changes nothing", async () => {
    await times(30, () => deleteServiceRoute(new Request("http://localhost"), params()));
    expect(await createBusinessDnaServiceAction({}, new FormData())).toEqual({
      error: "rate_limited",
    });
    expect(fx.createService).not.toHaveBeenCalled();
  });

  it("deactivating while limited changes nothing (and re-syncs nothing)", async () => {
    await times(30, () => deleteServiceRoute(new Request("http://localhost"), params()));
    fx.deactivateService.mockClear();
    await deactivateBusinessDnaServiceAction("svc-1");
    expect(fx.deactivateService).not.toHaveBeenCalled();
  });

  it("another organization's allowance is its own", async () => {
    await times(30, () => deleteServiceRoute(new Request("http://localhost"), params()));
    s.ctx = { ...ORG_B };
    expect((await deleteServiceRoute(new Request("http://localhost"), params())).status).toBe(200);
  });

  it.each(["timeout", "throw"] as const)(
    "answers 503 and changes nothing when the limit can't be verified (%s)",
    async (mode) => {
      s.mode = mode;
      const res = await createServiceRoute(json({ name: "Cut", durationMinutes: 30 }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: "service_unavailable" } });
      expect(fx.createService).not.toHaveBeenCalled();
      expect(await createBusinessDnaServiceAction({}, new FormData())).toEqual({
        error: "failed",
      });
    },
  );

  it("a profile save now also refuses on a Redis timeout (it was allowed)", async () => {
    s.mode = "timeout";
    const res = await saveProfileRoute(json({}, "PUT"));
    expect(res.status).toBe(503);
    expect(fx.upsertBusinessDNA).not.toHaveBeenCalled();
    expect(await updateBusinessDnaAction({}, new FormData())).toEqual({ error: "failed" });
  });

  it("checks the permission before counting anything", async () => {
    s.ctx = null;
    const res = await createServiceRoute(json({ name: "Cut" }));
    expect(res.status).toBe(403);
    expect(s.keys).toHaveLength(0);
  });
});

describe("Creator Studio post workflow (queue jobs, notifications, platform calls)", () => {
  const routes = {
    schedule: () => scheduleRoute(json(scheduleBody), params()),
    "request approval": () => requestApprovalRoute(new Request("http://localhost"), params()),
    review: () => reviewRoute(json({ decision: "APPROVE" }), params()),
    disconnect: () => disconnectRoute(new Request("http://localhost"), params(ACCOUNT_ID)),
  };
  const actions = {
    schedule: () => schedulePostAction(POST_ID, scheduleBody),
    "request approval": () => requestPostApprovalAction(POST_ID),
    review: () => reviewCreatorPostAction(POST_ID, { decision: "APPROVE" }),
    disconnect: () => disconnectSocialAccountAction(ACCOUNT_ID),
  };

  it.each(Object.keys(routes))("%s: 60 per user per 10 minutes, then 429", async (name) => {
    const results = await times(61, routes[name as keyof typeof routes]);
    expect(results.slice(0, 60).every((r) => r.status === 200)).toBe(true);
    expect(results[60]!.status).toBe(429);
    expect(Number(results[60]!.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it.each(Object.keys(actions))("%s action: refused once the allowance is used", async (name) => {
    await times(60, routes.schedule);
    expect(await actions[name as keyof typeof actions]()).toEqual({ error: "rate_limited" });
  });

  it("the allowance is per user: a colleague in the organization isn't blocked", async () => {
    await times(60, routes.schedule);
    s.ctx = { ...ORG_A, userId: "user-2" };
    expect((await routes.schedule()).status).toBe(200);
  });

  it("another organization's allowance is its own", async () => {
    await times(60, routes.schedule);
    s.ctx = { ...ORG_B };
    expect((await routes.schedule()).status).toBe(200);
  });

  it("nothing is scheduled, notified or disconnected while refused", async () => {
    await times(60, routes.schedule);
    vi.clearAllMocks();
    for (const run of Object.values(routes)) expect((await run()).status).toBe(429);
    for (const run of Object.values(actions)) await run();
    expect(fx.schedulePost).not.toHaveBeenCalled();
    expect(fx.requestPostApproval).not.toHaveBeenCalled();
    expect(fx.reviewCreatorPost).not.toHaveBeenCalled();
    expect(fx.disconnectSocialAccount).not.toHaveBeenCalled();
  });

  it.each(["timeout", "throw"] as const)(
    "fails closed when the limit can't be verified (%s)",
    async (mode) => {
      s.mode = mode;
      expect((await routes.schedule()).status).toBe(503);
      expect(await actions.schedule()).toEqual({ error: "service_unavailable" });
      expect(fx.schedulePost).not.toHaveBeenCalled();
    },
  );

  it("checks the permission before counting anything", async () => {
    s.ctx = null;
    expect((await routes.review()).status).toBe(403);
    expect(s.keys).toHaveLength(0);
  });
});

describe("server actions share their route's allowance", () => {
  it("creating posts through the app counts against the API route's limit", async () => {
    await times(100, () => createPostRoute(json({})));
    expect(await createCreatorPostAction({})).toEqual({ error: "rate_limited" });
    expect(fx.createCreatorPost).not.toHaveBeenCalled();
  });

  it("and the other way round", async () => {
    await times(100, () => createCreatorPostAction({}));
    expect((await createPostRoute(json({}))).status).toBe(429);
  });
});

describe("paid generations fail closed on a Redis timeout (they were allowed)", () => {
  it("route: 503 and no generation", async () => {
    s.mode = "timeout";
    const res = await captionRoute(json({ prompt: "x" }));
    expect(res.status).toBe(503);
    expect(fx.requestCaptionGeneration).not.toHaveBeenCalled();
  });

  it("action: service_unavailable and no generation", async () => {
    s.mode = "timeout";
    expect(await generateCaptionAction({ platform: "INSTAGRAM", language: "EN" })).toEqual({
      error: "service_unavailable",
    });
    expect(fx.requestCaptionGeneration).not.toHaveBeenCalled();
  });

  it("still 429 when the limit is reached", async () => {
    await times(20, () => captionRoute(json({})));
    const res = await captionRoute(json({}));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: "rate_limited" } });
  });
});
