import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every former direct `rateLimiters.*.limit()` call site now goes through the
 * shared fail-closed helpers (checkRateLimit → rateLimitRefusal /
 * actionRateLimitError). Upstash *allows* a request when Redis doesn't answer
 * in time (`success: true, reason: "timeout"`) and throws when Redis errors;
 * both used to let these requests through. Now:
 *
 *   allowed  → the operation runs
 *   limited  → 429 with Retry-After (actions: "rate_limited"), nothing runs
 *   timeout  → 503 (actions: "service_unavailable"), nothing runs
 *   error    → 503 (actions: "service_unavailable"), nothing runs
 *
 * The real helpers run against a fake Upstash. Inbox webhooks, KB/chat file
 * ingestion and the public assistant are covered in their own test files.
 */

const s = vi.hoisted(() => ({
  mode: "ok" as "ok" | "limited" | "timeout" | "throw",
  keys: [] as string[],
}));

const fx = vi.hoisted(() => ({
  signInWithPassword: vi.fn(async () => ({ error: null })),
  signUp: vi.fn(async () => ({ error: null })),
  signInWithOtp: vi.fn(async () => ({ error: null })),
  resetPasswordForEmail: vi.fn(async () => ({ error: null })),
  createPublicBooking: vi.fn(),
  getPublicSlots: vi.fn(async () => []),
  getBookingByToken: vi.fn(),
  rescheduleBookingViaToken: vi.fn(),
  cancelBookingViaToken: vi.fn(),
  notify: vi.fn(async () => ({ sent: true })),
  reminders: vi.fn(async () => undefined),
  createCreatorCampaign: vi.fn(async () => ({ id: "camp-1" })),
  connectSocialAccount: vi.fn(async () => ({ id: "acct-1" })),
  createCreatorPost: vi.fn(async () => ({ id: "post-1" })),
  createCreatorProfile: vi.fn(async () => ({ id: "prof-1" })),
  createReferenceAssetUploadUrl: vi.fn(async () => ({ uploadUrl: "https://x" })),
}));

vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    static slidingWindow() {
      return {};
    }
    private readonly prefix: string;
    constructor(opts: { prefix: string }) {
      this.prefix = opts.prefix;
    }
    async limit(key: string) {
      s.keys.push(`${this.prefix}|${key}`);
      if (s.mode === "throw") throw new Error("fetch failed");
      if (s.mode === "timeout") {
        return { success: true, reason: "timeout", limit: 0, remaining: 0, reset: 0 };
      }
      const reset = Date.now() + 60_000;
      return s.mode === "limited"
        ? { success: false, limit: 10, remaining: 0, reset }
        : { success: true, limit: 10, remaining: 9, reset };
    }
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.5" }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServer: async () => ({
    auth: {
      signInWithPassword: fx.signInWithPassword,
      signUp: fx.signUp,
      signInWithOtp: fx.signInWithOtp,
      resetPasswordForEmail: fx.resetPasswordForEmail,
      signOut: vi.fn(),
    },
  }),
}));

class BookingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
vi.mock("@/server/services/booking", () => ({
  createPublicBooking: fx.createPublicBooking,
  getPublicSlots: fx.getPublicSlots,
  getBookingByToken: fx.getBookingByToken,
  rescheduleBookingViaToken: fx.rescheduleBookingViaToken,
  cancelBookingViaToken: fx.cancelBookingViaToken,
  BookingError,
}));
vi.mock("@/server/services/booking-tokens", () => ({
  BookingTokenError: class BookingTokenError extends Error {},
}));
vi.mock("@/server/services/booking-notifications", () => ({
  sendBookingLifecycleNotifications: fx.notify,
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: fx.reminders }));

vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-1", role: "OWNER" })),
}));
vi.mock("@/server/services/creator-campaigns", () => ({
  createCreatorCampaign: fx.createCreatorCampaign,
  listCreatorCampaigns: vi.fn(),
}));
vi.mock("@/server/services/creator-social-accounts", () => ({
  connectSocialAccount: fx.connectSocialAccount,
}));
vi.mock("@/server/services/creator-posts", () => ({
  createCreatorPost: fx.createCreatorPost,
  listCreatorPosts: vi.fn(),
}));
vi.mock("@/server/services/creator-profiles", () => ({
  createCreatorProfile: fx.createCreatorProfile,
  createReferenceAssetUploadUrl: fx.createReferenceAssetUploadUrl,
  listCreatorProfiles: vi.fn(),
}));
vi.mock("@/server/services/creator-studio-http", async () => {
  const { NextResponse } = await import("next/server");
  return {
    handleCreatorStudioError: () =>
      NextResponse.json({ error: { code: "internal_error" } }, { status: 500 }),
  };
});

import { forgotPasswordAction, loginAction, magicLinkAction, registerAction } from "@/actions/auth";
import { POST as createBookingRoute } from "@/app/api/v1/booking/[org]/[slug]/route";
import { GET as slotsRoute } from "@/app/api/v1/booking/[org]/[slug]/slots/route";
import {
  DELETE as cancelRoute,
  GET as manageGetRoute,
  POST as rescheduleRoute,
} from "@/app/api/v1/booking/manage/[token]/route";
import { POST as campaignsRoute } from "@/app/api/v1/creator-studio/campaigns/route";
import { POST as socialConnectRoute } from "@/app/api/v1/creator-studio/social-accounts/connect/route";
import { POST as postsRoute } from "@/app/api/v1/creator-studio/posts/route";
import { POST as profilesRoute } from "@/app/api/v1/creator-studio/profiles/route";
import { POST as referenceUploadRoute } from "@/app/api/v1/creator-studio/profiles/[id]/reference-assets/upload-url/route";

const IP = { "x-forwarded-for": "203.0.113.5" };
const jsonRequest = (body: unknown, method = "POST") =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json", ...IP },
    body: JSON.stringify(body),
  });

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  f.set("locale", "en");
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  s.mode = "ok";
  s.keys = [];
  fx.createPublicBooking.mockResolvedValue({
    booking: {
      id: "b-1",
      organizationId: "org-a",
      startsAt: new Date("2026-10-07T06:00:00.000Z"),
      endsAt: new Date("2026-10-07T06:30:00.000Z"),
    },
    event: { id: "ev-1" },
    manageToken: "manage-1",
    bookingType: { name: "Intro" },
  });
  fx.getBookingByToken.mockResolvedValue({
    bookingType: { name: "Intro", location: null },
    status: "CONFIRMED",
    startsAt: new Date("2026-10-07T06:00:00.000Z"),
    endsAt: new Date("2026-10-07T06:30:00.000Z"),
    guestName: "Guest",
    guestTimezone: "Europe/Helsinki",
  });
  fx.rescheduleBookingViaToken.mockResolvedValue({
    booking: {
      id: "b-2",
      organizationId: "org-a",
      startsAt: new Date("2026-10-08T06:00:00.000Z"),
    },
    event: { id: "ev-2" },
    manageToken: "manage-2",
  });
  fx.cancelBookingViaToken.mockResolvedValue({ id: "b-1" });
});

const authActions: Array<{
  name: string;
  // loginAction redirects on success and returns nothing.
  run: () => Promise<{ error?: string } | void>;
  effect: () => number;
}> = [
  {
    name: "loginAction",
    run: () => loginAction({}, form({ email: "a@example.com", password: "correct-horse-1" })),
    effect: () => fx.signInWithPassword.mock.calls.length,
  },
  {
    name: "registerAction",
    run: () =>
      registerAction(
        {},
        form({ email: "a@example.com", password: "correct-horse-1", fullName: "A Person" }),
      ),
    effect: () => fx.signUp.mock.calls.length,
  },
  {
    name: "magicLinkAction",
    run: () => magicLinkAction({}, form({ email: "a@example.com" })),
    effect: () => fx.signInWithOtp.mock.calls.length,
  },
  {
    name: "forgotPasswordAction",
    run: () => forgotPasswordAction({}, form({ email: "a@example.com" })),
    effect: () => fx.resetPasswordForEmail.mock.calls.length,
  },
];

describe.each(authActions)("$name (auth limiter, per IP)", ({ run, effect }) => {
  it("runs the auth operation when the limit allows it", async () => {
    const result = await run();
    expect(result?.error).toBeUndefined();
    expect(effect()).toBe(1);
    expect(s.keys.every((k) => k.startsWith("rl:auth|") && k.endsWith(":203.0.113.5"))).toBe(true);
  });

  it.each([
    ["limited", "rate_limited"],
    ["timeout", "service_unavailable"],
    ["throw", "service_unavailable"],
  ] as const)("refuses with %s and never reaches Supabase Auth", async (mode, error) => {
    s.mode = mode;
    expect(await run()).toEqual({ error });
    expect(effect()).toBe(0);
  });
});

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const SLOT_QUERY = "?from=2026-10-07T00:00:00.000Z&to=2026-10-08T00:00:00.000Z";

const routes: Array<{
  name: string;
  run: () => Promise<Response>;
  effect: () => number;
}> = [
  {
    name: "POST /booking/[org]/[slug] (create)",
    run: () =>
      createBookingRoute(
        jsonRequest({
          startsAt: "2026-10-07T06:00:00.000Z",
          timezone: "Europe/Helsinki",
          name: "Guest",
          email: "guest@example.com",
          consent: true,
          locale: "en",
        }),
        params({ org: "acme", slug: "intro" }),
      ),
    effect: () => fx.createPublicBooking.mock.calls.length + fx.notify.mock.calls.length,
  },
  {
    name: "GET /booking/[org]/[slug]/slots",
    run: () =>
      slotsRoute(
        new Request(`http://localhost/api${SLOT_QUERY}`, { headers: IP }),
        params({ org: "acme", slug: "intro" }),
      ),
    effect: () => fx.getPublicSlots.mock.calls.length,
  },
  {
    name: "GET /booking/manage/[token]",
    run: () =>
      manageGetRoute(new Request("http://localhost/api", { headers: IP }), params({ token: "t" })),
    effect: () => fx.getBookingByToken.mock.calls.length,
  },
  {
    name: "POST /booking/manage/[token] (reschedule)",
    run: () =>
      rescheduleRoute(
        jsonRequest({ startsAt: "2026-10-08T06:00:00.000Z" }),
        params({ token: "t" }),
      ),
    effect: () => fx.rescheduleBookingViaToken.mock.calls.length + fx.notify.mock.calls.length,
  },
  {
    name: "DELETE /booking/manage/[token] (cancel)",
    run: () => cancelRoute(jsonRequest({}, "DELETE"), params({ token: "t" })),
    effect: () => fx.cancelBookingViaToken.mock.calls.length + fx.notify.mock.calls.length,
  },
  {
    name: "POST /creator-studio/campaigns",
    run: () => campaignsRoute(jsonRequest({})),
    effect: () => fx.createCreatorCampaign.mock.calls.length,
  },
  {
    name: "POST /creator-studio/social-accounts/connect",
    run: () => socialConnectRoute(jsonRequest({})),
    effect: () => fx.connectSocialAccount.mock.calls.length,
  },
  {
    name: "POST /creator-studio/posts",
    run: () => postsRoute(jsonRequest({})),
    effect: () => fx.createCreatorPost.mock.calls.length,
  },
  {
    name: "POST /creator-studio/profiles",
    run: () => profilesRoute(jsonRequest({})),
    effect: () => fx.createCreatorProfile.mock.calls.length,
  },
  {
    name: "POST /creator-studio/profiles/[id]/reference-assets/upload-url",
    run: () => referenceUploadRoute(jsonRequest({}), params({ id: "prof-1" })),
    effect: () => fx.createReferenceAssetUploadUrl.mock.calls.length,
  },
];

describe.each(routes)("$name", ({ name, run, effect }) => {
  it("passes the limiter when it allows the request", async () => {
    const response = await run();
    expect([429, 503]).not.toContain(response.status);
    expect(s.keys).toHaveLength(1);
    // Booking writes and reads run their operation; Creator Studio requests
    // here carry an empty body, so passing the limiter shows as a 400 from
    // validation (their success paths are covered in their own suites).
    if (name.includes("/booking/")) expect(effect()).toBeGreaterThan(0);
    else expect(response.status).toBe(400);
  });

  it("answers 429 with Retry-After at the limit, and runs nothing", async () => {
    s.mode = "limited";
    const response = await run();
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: { code: "rate_limited" } });
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(effect()).toBe(0);
  });

  it.each(["timeout", "throw"] as const)(
    "fails closed with 503 on a Redis %s, and runs nothing",
    async (mode) => {
      s.mode = mode;
      const response = await run();
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: { code: "service_unavailable" } });
      expect(effect()).toBe(0);
    },
  );
});

describe("limit keys", () => {
  it("keeps per-IP booking keys and per-org/user Creator Studio keys", async () => {
    for (const { run } of routes) await run();
    expect(s.keys).toEqual([
      "rl:auth|booking-create:203.0.113.5",
      "rl:api|booking-slots:203.0.113.5",
      "rl:api|booking-manage:203.0.113.5",
      "rl:auth|booking-manage:203.0.113.5",
      "rl:auth|booking-manage:203.0.113.5",
      "rl:api|creator-campaigns-create:org-a:user-1",
      "rl:api|creator-social-connect:org-a:user-1",
      "rl:api|creator-posts-create:org-a:user-1",
      "rl:api|creator-profiles-create:org-a:user-1",
      "rl:api|creator-reference-upload-url:org-a:user-1",
    ]);
  });
});
