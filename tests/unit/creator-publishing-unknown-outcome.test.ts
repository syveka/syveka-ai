import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A publish whose outcome on the platform is unknown must never be published
 * again automatically. Two ways to get there:
 * - the function is killed after the platform published but before the post
 *   was recorded; the stale sweep then marks it FAILED (publish_interrupted)
 *   while a QStash retry of the same message is still pending;
 * - the call that publishes times out (or the connection drops), so the
 *   platform may have published without us seeing its answer.
 *
 * Synthetic data and a stateful in-memory fake of the creatorPost table that
 * evaluates the engine's real `where` clauses (NULL handled as in SQL). The
 * second suite runs the real Instagram provider and Meta client with only
 * `fetch` faked: the fake platform counts how many posts it created.
 */

type PostRow = {
  id: string;
  organizationId: string;
  createdById: string;
  platform: "INSTAGRAM";
  caption: string;
  hashtags: string[];
  assetIds: string[];
  approvalStatus: "APPROVED";
  contentVersion: number;
  approvedContentVersion: number;
  publishStatus: "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "FAILED";
  lastErrorCode: string | null;
  lastErrorSafe: string | null;
  externalPostId: string | null;
  publishedAt: Date | null;
  publishAttemptCount: number;
  scheduledFor: Date;
  updatedAt: Date;
  campaignId: null;
};

const db = vi.hoisted(() => ({ posts: [] as Array<Record<string, unknown>> }));
const fx = vi.hoisted(() => ({
  provider: null as null | { publishPost: (...args: never[]) => Promise<unknown> },
  audit: vi.fn(async (_ctx: unknown, _entry: { action: string; after?: unknown }) => undefined),
  notifyUser: vi.fn(async (_ctx: unknown, _userId: string, _n: { title: string }) => undefined),
}));

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond && typeof cond === "object") {
    const c = cond as Record<string, unknown>;
    // SQL semantics: a comparison with NULL is never true.
    if ("in" in c) return value !== null && (c.in as unknown[]).includes(value);
    if ("notIn" in c) return value !== null && !(c.notIn as unknown[]).includes(value);
    if ("not" in c) return value !== null && value !== c.not;
    if ("lt" in c) return value instanceof Date && value.getTime() < (c.lt as Date).getTime();
    throw new Error(`fake does not support condition ${JSON.stringify(c)}`);
  }
  return value === cond;
}

function rowMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) =>
    k === "OR"
      ? (v as Array<Record<string, unknown>>).some((w) => rowMatches(row, w))
      : fieldMatches(row[k], v),
  );
}

function apply(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    row[k] =
      v && typeof v === "object" && "increment" in v
        ? (row[k] as number) + (v as { increment: number }).increment
        : v;
  }
  row.updatedAt = new Date(); // Prisma @updatedAt
}

const SOCIAL_ACCOUNT = {
  id: "acct-1",
  organizationId: "org-a",
  status: "CONNECTED",
  accessTokenEnc: "enc:token",
  externalAccountId: "ig-1",
};

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(),
  unscopedPrisma: {
    creatorPost: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = db.posts.find((p) => rowMatches(p, where));
        return row ? { ...row, campaign: null, socialAccount: SOCIAL_ACCOUNT } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        db.posts.filter((p) => rowMatches(p, where)).map((p) => ({ ...p })),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const rows = db.posts.filter((p) => rowMatches(p, where));
          rows.forEach((r) => apply(r, data));
          return { count: rows.length };
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = db.posts.find((p) => p.id === where.id)!;
          apply(row, data);
          return { ...row };
        },
      ),
      count: vi.fn(async () => 0),
    },
    creatorReferenceAsset: {
      findMany: vi.fn(async () => [
        {
          id: "asset-1",
          storagePath: "org-a/x.png",
          assetType: "generated_image",
          source: "UPLOAD",
        },
      ]),
    },
  },
}));
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: vi.fn(async () => true),
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/social", () => ({ getSocialPublishingProvider: () => fx.provider }));
vi.mock("@/server/integrations/social/crypto", () => ({
  decryptSocialToken: () => "page-token",
  encryptSocialToken: (v: string) => `enc:${v}`,
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://storage.example/signed/x.png" },
          error: null,
        }),
      }),
    },
  }),
}));
vi.mock("@/server/services/audit", () => ({ audit: fx.audit }));
vi.mock("@/server/services/creator-notifications", () => ({ notifyUser: fx.notifyUser }));

import {
  PUBLISH_STALE_MS,
  failStalePublishingPosts,
  publishCreatorPost,
} from "@/server/services/creator-publishing";
import { InstagramPublishingProvider } from "@/server/social/meta-provider";
import { maxDuration as publishJobMaxDurationSeconds } from "@/app/api/v1/jobs/publish-creator-post/route";

const T0 = new Date("2026-11-02T10:00:00Z");
const SEC = 1000;
const MIN = 60 * SEC;

function seedPost(overrides: Partial<PostRow> = {}): PostRow {
  const row: PostRow = {
    id: "post-1",
    organizationId: "org-a",
    createdById: "user-1",
    platform: "INSTAGRAM",
    caption: "hello",
    hashtags: [],
    assetIds: ["asset-1"],
    approvalStatus: "APPROVED",
    contentVersion: 1,
    approvedContentVersion: 1,
    publishStatus: "SCHEDULED",
    lastErrorCode: null,
    lastErrorSafe: null,
    externalPostId: null,
    publishedAt: null,
    publishAttemptCount: 0,
    scheduledFor: T0,
    updatedAt: T0,
    campaignId: null,
    ...overrides,
  };
  db.posts = [row as unknown as Record<string, unknown>];
  return row;
}
const post = () => db.posts[0] as unknown as PostRow;

/** What the author's "schedule again" does to the row (creator-posts.ts schedulePost). */
function authorReschedules(at: Date): void {
  apply(db.posts[0]!, { publishStatus: "SCHEDULED", scheduledFor: at });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  db.posts = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a run killed after the platform published", () => {
  let platformPosts: number;

  beforeEach(() => {
    platformPosts = 0;
    fx.provider = {
      publishPost: vi.fn(async () => {
        platformPosts += 1;
        // First delivery: the platform created the post, then the function is
        // killed before the answer is recorded (that delivery never finishes).
        if (platformPosts === 1) return new Promise(() => undefined);
        return { externalPostId: `ig-dup-${platformPosts}`, providerRequestId: "dup" };
      }),
    };
  });

  it("is not published again when the sweep marks it interrupted and QStash retries", async () => {
    seedPost();
    void publishCreatorPost("org-a", "post-1", { finalAttempt: false });
    for (let i = 0; i < 100 && platformPosts === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(platformPosts).toBe(1);
    expect(post().publishStatus).toBe("PUBLISHING");

    // QStash retries of the same message (backoff e^(2.5n) s: ~12 s, ~2.5 min, ~30 min).
    vi.setSystemTime(new Date(T0.getTime() + 12 * SEC));
    expect(await publishCreatorPost("org-a", "post-1", { finalAttempt: false })).toBe(
      "in_progress",
    );
    vi.setSystemTime(new Date(T0.getTime() + 150 * SEC));
    expect(await publishCreatorPost("org-a", "post-1", { finalAttempt: false })).toBe(
      "in_progress",
    );

    // The reconcile job's sweep, after the stale window.
    vi.setSystemTime(new Date(T0.getTime() + PUBLISH_STALE_MS + MIN));
    expect(await failStalePublishingPosts()).toBe(1);
    expect(post()).toMatchObject({ publishStatus: "FAILED", lastErrorCode: "publish_interrupted" });

    vi.setSystemTime(new Date(T0.getTime() + 30 * MIN));
    expect(await publishCreatorPost("org-a", "post-1", { finalAttempt: true })).toBe("done");

    expect(platformPosts).toBe(1);
    expect(fx.provider!.publishPost).toHaveBeenCalledTimes(1);
    expect(post().lastErrorCode).toBe("publish_interrupted");
    // The author was told once, by the sweep, to check the platform.
    expect(fx.notifyUser).toHaveBeenCalledTimes(1);
    expect(fx.notifyUser.mock.calls[0]![2].title).toBe("Publishing was interrupted");
  });

  it("the author scheduling it again is the way to publish it after checking the platform", async () => {
    seedPost({ publishStatus: "FAILED", lastErrorCode: "publish_interrupted" });
    fx.provider = {
      publishPost: vi.fn(async () => ({ externalPostId: "ig-2", providerRequestId: "ig-2" })),
    };

    expect(await publishCreatorPost("org-a", "post-1")).toBe("done");
    expect(fx.provider.publishPost).not.toHaveBeenCalled();

    authorReschedules(T0);
    expect(await publishCreatorPost("org-a", "post-1")).toBe("done");
    expect(fx.provider.publishPost).toHaveBeenCalledTimes(1);
    expect(post()).toMatchObject({ publishStatus: "PUBLISHED", externalPostId: "ig-2" });
  });

  it("a definitive failure stays retryable: a FAILED post with another code (or none) is claimed", async () => {
    fx.provider = {
      publishPost: vi.fn(async () => ({ externalPostId: "ig-3", providerRequestId: "ig-3" })),
    };
    seedPost({ publishStatus: "FAILED", lastErrorCode: "publish_failed" });
    expect(await publishCreatorPost("org-a", "post-1")).toBe("done");
    seedPost({ publishStatus: "FAILED", lastErrorCode: null });
    expect(await publishCreatorPost("org-a", "post-1")).toBe("done");
    expect(fx.provider.publishPost).toHaveBeenCalledTimes(2);
  });

  it("the sweep never overtakes a live attempt: the stale window outlasts the job's maxDuration", () => {
    // The only writer of a claimed post is the run that claimed it, and the platform stops
    // that run at maxDuration; a sweep that ran sooner could fail a post still publishing.
    expect(PUBLISH_STALE_MS).toBeGreaterThan(publishJobMaxDurationSeconds * 1000 + MIN);
  });

  it("another organization's job cannot claim the post", async () => {
    seedPost({ publishStatus: "FAILED", lastErrorCode: "publish_failed" });
    fx.provider = { publishPost: vi.fn() };
    await expect(publishCreatorPost("org-b", "post-1")).rejects.toMatchObject({
      code: "post_not_found",
    });
    expect(fx.provider.publishPost).not.toHaveBeenCalled();
    expect(post().publishStatus).toBe("FAILED");
  });
});

describe("the call that publishes times out (real Instagram provider, fake Graph API)", () => {
  let platformPosts: number;
  let publishCall: "timeout" | "reset" | "5xx" | "no-id" | "4xx" | "ok";
  let containerCall: "ok" | "timeout";

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  beforeEach(() => {
    platformPosts = 0;
    publishCall = "timeout";
    containerCall = "ok";
    fx.provider = new InstagramPublishingProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/media_publish")) {
          if (publishCall === "4xx") {
            return json({ error: { message: "Media ID is not available", code: 9007 } }, 400);
          }
          platformPosts += 1; // the platform publishes; what we hear back varies
          if (publishCall === "timeout") {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          }
          if (publishCall === "reset") throw new TypeError("fetch failed");
          if (publishCall === "5xx")
            return json({ error: { message: "Service unavailable" } }, 503);
          if (publishCall === "no-id") return json({});
          return json({ id: `ig-post-${platformPosts}` });
        }
        if (url.includes("fields=status_code")) return json({ status_code: "FINISHED" });
        if (url.endsWith("/media")) {
          if (containerCall === "timeout") {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          }
          return json({ id: "container-1" });
        }
        throw new Error(`unexpected Graph call ${url}`);
      }),
    );
  });

  it.each(["timeout", "reset", "5xx", "no-id"] as const)(
    "%s on media_publish: recorded as an unknown outcome, not retried, never republished",
    async (answer) => {
      publishCall = answer;
      seedPost();
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

      // Not thrown: the job answers 200 and QStash does not retry.
      expect(await publishCreatorPost("org-a", "post-1", { finalAttempt: false })).toBe("done");
      expect(post()).toMatchObject({
        publishStatus: "FAILED",
        lastErrorCode: "publish_outcome_unknown",
      });
      expect(post().lastErrorSafe).toMatch(/may have been published/i);
      // Told now (no retry follows), and audited with the code only.
      expect(fx.notifyUser).toHaveBeenCalledTimes(1);
      expect(fx.audit).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-a" }),
        expect.objectContaining({
          action: "creator.post.publish_failed",
          after: { errorCode: "publish_outcome_unknown" },
        }),
      );

      // Any further delivery of the message publishes nothing.
      publishCall = "ok";
      expect(await publishCreatorPost("org-a", "post-1", { finalAttempt: true })).toBe("done");
      expect(platformPosts).toBe(1);
      expect(String(log.mock.calls.flat().join(" "))).not.toContain("page-token");
      log.mockRestore();
    },
  );

  it("a Graph error answer on media_publish is a definitive failure: retried, published once", async () => {
    publishCall = "4xx";
    seedPost();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(publishCreatorPost("org-a", "post-1", { finalAttempt: false })).rejects.toThrow();
    expect(post()).toMatchObject({ publishStatus: "FAILED", lastErrorCode: "publish_failed" });
    expect(platformPosts).toBe(0);

    publishCall = "ok";
    expect(await publishCreatorPost("org-a", "post-1", { finalAttempt: true })).toBe("done");
    expect(platformPosts).toBe(1);
    expect(post().publishStatus).toBe("PUBLISHED");
    log.mockRestore();
  });

  it("a timeout before media_publish (container creation) published nothing: retried normally", async () => {
    containerCall = "timeout";
    seedPost();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(publishCreatorPost("org-a", "post-1", { finalAttempt: false })).rejects.toThrow();
    expect(post()).toMatchObject({ publishStatus: "FAILED", lastErrorCode: "publish_failed" });

    containerCall = "ok";
    publishCall = "ok";
    expect(await publishCreatorPost("org-a", "post-1", { finalAttempt: true })).toBe("done");
    expect(platformPosts).toBe(1);
    expect(post().publishStatus).toBe("PUBLISHED");
    log.mockRestore();
  });
});
