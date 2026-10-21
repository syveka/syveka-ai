import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Publishing must never leave a post PUBLISHING for good, and must never post
 * twice. A run stopped mid-publish (the function's time limit) is found by the
 * delayed check scheduled at each claim and marked FAILED for a person to
 * check; a publish request without a definite answer is not retried either.
 * Rescheduling, by someone allowed to publish, is the only way to try again.
 *
 * The posts live in an in-memory table whose updateMany applies the same
 * conditions as the database (status, attempt, error code, updatedAt), so
 * redeliveries, retries and checks interact as they would in production.
 */

type Post = Record<string, unknown> & {
  id: string;
  organizationId: string;
  publishStatus: string;
  publishAttemptCount: number;
  lastErrorCode: string | null;
  updatedAt: Date;
};

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const POST = "11111111-1111-4111-8111-111111111111";

const s = vi.hoisted(() => ({
  posts: [] as Array<Record<string, unknown>>,
  failUpdates: 0,
  activeOrgs: new Set<string>(),
}));

const fx = vi.hoisted(() => ({
  publishPost: vi.fn(),
  enqueue: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
  notifyUser: vi.fn(async () => undefined),
}));

type Where = Record<string, unknown>;

function matches(post: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Where[]).some((w) => matches(post, w));
    const value = post[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date || typeof cond !== "object") return value === cond;
    const c = cond as { in?: unknown[]; notIn?: unknown[]; lt?: Date };
    if (c.in) return c.in.includes(value);
    if (c.notIn) return value !== null && value !== undefined && !c.notIn.includes(value);
    if (c.lt) return (value as Date).getTime() < c.lt.getTime();
    throw new Error(`unsupported condition on ${key}`);
  });
}

function apply(post: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    post[key] =
      value && typeof value === "object" && "increment" in value
        ? (post[key] as number) + (value as { increment: number }).increment
        : value;
  }
  post.updatedAt = new Date(); // Prisma @updatedAt, including updateMany
}

const db = {
  creatorPost: {
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      const post = s.posts.find((p) => matches(p, where));
      if (!post) return null;
      const account = post.socialAccount as Record<string, unknown> | null;
      return { ...post, campaign: null, socialAccount: account ? { ...account } : null };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const hits = s.posts.filter((p) => matches(p, where));
      hits.forEach((p) => apply(p, data));
      return { count: hits.length };
    }),
    update: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      if (s.failUpdates > 0) {
        s.failUpdates--;
        throw new Error("database unavailable");
      }
      const post = s.posts.find((p) => p.id === where.id)!;
      apply(post, data);
      return post;
    }),
    count: vi.fn(async () => 0),
  },
  creatorReferenceAsset: {
    findMany: vi.fn(async () => [
      { id: "asset-1", storagePath: "org-a/x.png", assetType: "generated_image" },
    ]),
  },
  socialAccount: {
    findFirstOrThrow: vi.fn(async () => ({ id: "acct-1", status: "CONNECTED" })),
  },
};

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
  tenantDb: (orgId: string) => ({
    creatorPost: {
      findFirstOrThrow: async ({ where }: { where: Where }) => {
        const post = s.posts.find((p) => matches(p, { ...where, organizationId: orgId }));
        if (!post) throw new Error("not found");
        return { ...post };
      },
      updateMany: ({ where, data }: { where: Where; data: Record<string, unknown> }) =>
        db.creatorPost.updateMany({ where: { ...where, organizationId: orgId }, data }),
    },
    socialAccount: db.socialAccount,
  }),
}));
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: vi.fn(async (orgId: string) => s.activeOrgs.has(orgId)),
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: fx.enqueue }));
vi.mock("@/server/social", () => ({
  getSocialPublishingProvider: () => ({ publishPost: fx.publishPost }),
}));
vi.mock("@/server/integrations/social/crypto", () => ({
  decryptSocialToken: () => "plain-token",
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://storage.test/x" },
          error: null,
        }),
      }),
    },
  }),
}));
vi.mock("@/server/services/audit", () => ({ audit: fx.audit }));
vi.mock("@/server/services/creator-notifications", () => ({
  notifyUser: fx.notifyUser,
  notifyApprovers: vi.fn(),
}));
vi.mock("@/server/services/feature-flags", () => ({ assertFeatureEnabled: vi.fn() }));

import {
  publishCreatorPost,
  recoverStalePublish,
  StaleCheckTooEarlyError,
  STALE_CHECK_DELAY_SECONDS,
  STALE_PUBLISHING_AFTER_MS,
} from "@/server/services/creator-publishing";
import { schedulePost } from "@/server/services/creator-posts";
import { PublishOutcomeUnknownError } from "@/server/social/types";
import { maxDuration } from "@/app/api/v1/jobs/publish-creator-post/route";
import {
  CONTAINER_POLL_TIMEOUT_MS,
  GRAPH_REQUEST_TIMEOUT_MS,
} from "@/server/integrations/meta/client";

const post = (): Post => s.posts.find((p) => p.id === POST) as Post;
const providerCalls = () => fx.publishPost.mock.calls.length;
const auditActions = () =>
  fx.audit.mock.calls.map((c) => (c as unknown as [unknown, { action: string }])[1].action);
const staleChecks = () =>
  fx.enqueue.mock.calls.filter(
    (c) => (c as unknown as [string, { staleCheck?: number }])[1].staleCheck !== undefined,
  );

/** Moves the clock past the point where the attempt's run must have ended. */
function afterRunLimit() {
  vi.setSystemTime(new Date(Date.now() + STALE_PUBLISHING_AFTER_MS + 1000));
}

/** The function was stopped mid-publish: the claim committed, nothing after it did. */
function interruptedAttempt(attempt = 1) {
  Object.assign(post(), { publishStatus: "PUBLISHING", publishAttemptCount: attempt });
  post().updatedAt = new Date();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T08:00:00Z"));
  s.failUpdates = 0;
  s.activeOrgs = new Set([ORG_A, ORG_B]);
  s.posts = [
    {
      id: POST,
      organizationId: ORG_A,
      createdById: "user-1",
      platform: "INSTAGRAM",
      caption: "hello",
      hashtags: [],
      assetIds: ["asset-1"],
      approvalStatus: "APPROVED",
      contentVersion: 1,
      approvedContentVersion: 1,
      publishStatus: "SCHEDULED",
      publishAttemptCount: 0,
      lastErrorCode: null,
      lastErrorSafe: null,
      externalPostId: null,
      campaignId: null,
      scheduledFor: new Date("2026-10-12T08:00:00Z"),
      socialAccountId: "acct-1",
      socialAccount: {
        id: "acct-1",
        organizationId: ORG_A,
        status: "CONNECTED",
        accessTokenEnc: "enc",
        externalAccountId: "ig-1",
      },
      updatedAt: new Date("2026-10-12T07:00:00Z"),
    },
  ];
  fx.publishPost.mockResolvedValue({ externalPostId: "ig-media-1", providerRequestId: "r" });
});

describe("time budget", () => {
  it("a healthy Instagram publish fits inside the job's time limit", () => {
    // signing + container create + polling (last poll may take a full request) + publish
    const worstCaseMs = CONTAINER_POLL_TIMEOUT_MS + 3 * GRAPH_REQUEST_TIMEOUT_MS + 30_000;
    expect(worstCaseMs).toBeLessThan(maxDuration * 1000);
  });

  it("a post is only declared interrupted after its run must have ended", () => {
    expect(STALE_PUBLISHING_AFTER_MS).toBeGreaterThan(maxDuration * 1000);
    expect(STALE_CHECK_DELAY_SECONDS * 1000).toBeGreaterThan(STALE_PUBLISHING_AFTER_MS);
  });
});

describe("healthy publishing (unchanged)", () => {
  it("publishes once, records it, and schedules a check for that attempt", async () => {
    expect(await publishCreatorPost(ORG_A, POST)).toBe("done");

    expect(providerCalls()).toBe(1);
    expect(post()).toMatchObject({ publishStatus: "PUBLISHED", externalPostId: "ig-media-1" });
    expect(fx.enqueue).toHaveBeenCalledWith(
      "publish-creator-post",
      { orgId: ORG_A, postId: POST, staleCheck: 1 },
      {
        delaySeconds: STALE_CHECK_DELAY_SECONDS,
        deduplicationId: `publish-creator-post:stale-check:${POST}:1`,
      },
    );
  });

  it("the check after a successful publish changes nothing", async () => {
    await publishCreatorPost(ORG_A, POST);
    afterRunLimit();

    expect(await recoverStalePublish(ORG_A, POST, 1)).toBe("done");
    expect(post().publishStatus).toBe("PUBLISHED");
    expect(auditActions()).toEqual(["creator.post.published"]);
  });

  it("a failure to schedule the check doesn't stop the publish", async () => {
    fx.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await publishCreatorPost(ORG_A, POST);
    expect(post().publishStatus).toBe("PUBLISHED");
  });
});

describe("definite provider failures (unchanged: QStash retries, bounded)", () => {
  it("a provider error marks FAILED and throws, so QStash retries", async () => {
    fx.publishPost.mockRejectedValueOnce(new Error("Meta Graph API error: bad media"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(publishCreatorPost(ORG_A, POST)).rejects.toThrow();
    expect(post()).toMatchObject({ publishStatus: "FAILED", lastErrorCode: "publish_failed" });
  });

  it("a transient failure then a successful retry publishes exactly once", async () => {
    fx.publishPost.mockRejectedValueOnce(new Error("timed out before publishing"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(publishCreatorPost(ORG_A, POST)).rejects.toThrow();
    await publishCreatorPost(ORG_A, POST); // QStash redelivery

    expect(providerCalls()).toBe(2);
    expect(post()).toMatchObject({ publishStatus: "PUBLISHED", publishAttemptCount: 2 });
    expect(
      staleChecks().map((c) => (c as unknown as [string, { staleCheck: number }])[1].staleCheck),
    ).toEqual([1, 2]);
  });

  it("repeated failures stay one provider call per delivery, with no loop of their own", async () => {
    fx.publishPost.mockRejectedValue(new Error("still failing"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // the first delivery and QStash's 3 retries (src/server/jobs/queue.ts)
    for (let i = 0; i < 4; i++) await expect(publishCreatorPost(ORG_A, POST)).rejects.toThrow();

    expect(providerCalls()).toBe(4);
    expect(post()).toMatchObject({ publishStatus: "FAILED", publishAttemptCount: 4 });
    const publishJobs = fx.enqueue.mock.calls.filter(
      (c) => (c as unknown as [string, { staleCheck?: number }])[1].staleCheck === undefined,
    );
    expect(publishJobs).toHaveLength(0); // never re-enqueues a publish itself
  });
});

describe("interrupted run (the function was stopped mid-publish)", () => {
  it("a redelivery can't claim it, so it never publishes twice", async () => {
    interruptedAttempt();

    expect(await publishCreatorPost(ORG_A, POST)).toBe("done");
    expect(providerCalls()).toBe(0);
    expect(post().publishStatus).toBe("PUBLISHING");
  });

  it("the delayed check marks it FAILED for review, audited and notified, without publishing", async () => {
    interruptedAttempt();
    afterRunLimit();

    expect(await recoverStalePublish(ORG_A, POST, 1)).toBe("recovered");
    expect(post()).toMatchObject({ publishStatus: "FAILED", lastErrorCode: "publish_interrupted" });
    expect(post().lastErrorSafe).toMatch(/may already be live/);
    expect(providerCalls()).toBe(0);
    expect(fx.audit).toHaveBeenCalledWith(
      { orgId: ORG_A, userId: "user-1" },
      expect.objectContaining({
        action: "creator.post.publish_interrupted",
        actorType: "system",
        resourceId: POST,
      }),
    );
    expect(fx.notifyUser).toHaveBeenCalledTimes(1);
  });

  it("is never claimed again automatically after recovery (no blind republish)", async () => {
    interruptedAttempt();
    afterRunLimit();
    await recoverStalePublish(ORG_A, POST, 1);

    expect(await publishCreatorPost(ORG_A, POST)).toBe("done"); // late QStash retry
    expect(providerCalls()).toBe(0);
    expect(post().publishStatus).toBe("FAILED");
  });

  it("an early check leaves the run alone and is delivered again (QStash retry)", async () => {
    interruptedAttempt();

    await expect(recoverStalePublish(ORG_A, POST, 1)).rejects.toThrow(StaleCheckTooEarlyError);
    expect(post().publishStatus).toBe("PUBLISHING");
    expect(fx.audit).not.toHaveBeenCalled();
  });

  it("a check for an older attempt doesn't touch a newer attempt", async () => {
    interruptedAttempt(2);
    afterRunLimit();

    expect(await recoverStalePublish(ORG_A, POST, 1)).toBe("done");
    expect(post().publishStatus).toBe("PUBLISHING");
  });

  it("two checks racing for the same attempt recover it once", async () => {
    interruptedAttempt();
    afterRunLimit();

    const results = await Promise.all([
      recoverStalePublish(ORG_A, POST, 1),
      recoverStalePublish(ORG_A, POST, 1),
    ]);
    expect(results.sort()).toEqual(["done", "recovered"]);
    expect(fx.audit).toHaveBeenCalledTimes(1);
    expect(fx.notifyUser).toHaveBeenCalledTimes(1);
  });

  it("published on the platform, but recording it failed: reviewed, never republished", async () => {
    s.failUpdates = 2; // markPublished and its one retry both fail
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await publishCreatorPost(ORG_A, POST)).toBe("done");
    expect(post().publishStatus).toBe("PUBLISHING");
    expect(await publishCreatorPost(ORG_A, POST)).toBe("done"); // redelivery
    afterRunLimit();
    expect(await recoverStalePublish(ORG_A, POST, 1)).toBe("recovered");

    expect(providerCalls()).toBe(1);
    expect(post().lastErrorCode).toBe("publish_interrupted");
  });
});

describe("publish request without a definite answer", () => {
  it("is recorded for review and not retried (no throw), audited and notified", async () => {
    fx.publishPost.mockRejectedValueOnce(new PublishOutcomeUnknownError("no response"));

    expect(await publishCreatorPost(ORG_A, POST)).toBe("done");
    expect(post()).toMatchObject({
      publishStatus: "FAILED",
      lastErrorCode: "publish_outcome_unknown",
    });
    expect(auditActions()).toEqual(["creator.post.publish_outcome_unknown"]);
    expect(fx.notifyUser).toHaveBeenCalledTimes(1);
  });

  it("a duplicate delivery afterwards doesn't publish again", async () => {
    fx.publishPost.mockRejectedValueOnce(new PublishOutcomeUnknownError("no response"));
    await publishCreatorPost(ORG_A, POST);

    expect(await publishCreatorPost(ORG_A, POST)).toBe("done");
    expect(providerCalls()).toBe(1);
  });
});

describe("retrying after review", () => {
  const ctx = { orgId: ORG_A, userId: "user-2", role: "ADMIN" } as never;

  it("rescheduling clears the review code, and the next delivery publishes once", async () => {
    interruptedAttempt();
    afterRunLimit();
    await recoverStalePublish(ORG_A, POST, 1);

    await schedulePost(ctx, POST, { scheduledFor: new Date(), socialAccountId: "acct-1" });
    expect(post()).toMatchObject({ publishStatus: "SCHEDULED", lastErrorCode: null });

    await publishCreatorPost(ORG_A, POST);
    expect(providerCalls()).toBe(1);
    expect(post().publishStatus).toBe("PUBLISHED");
  });

  it("another organization can't reschedule this organization's post", async () => {
    interruptedAttempt();
    afterRunLimit();
    await recoverStalePublish(ORG_A, POST, 1);

    await expect(
      schedulePost({ orgId: ORG_B, userId: "user-3" } as never, POST, {
        scheduledFor: new Date(),
        socialAccountId: "acct-1",
      }),
    ).rejects.toThrow();
    expect(post()).toMatchObject({ publishStatus: "FAILED", lastErrorCode: "publish_interrupted" });
  });
});

describe("tenant isolation", () => {
  it("a check addressed to another organization changes nothing", async () => {
    interruptedAttempt();
    afterRunLimit();

    expect(await recoverStalePublish(ORG_B, POST, 1)).toBe("done");
    expect(post().publishStatus).toBe("PUBLISHING");
    expect(fx.audit).not.toHaveBeenCalled();
  });

  it("a check for a deleted organization changes nothing", async () => {
    interruptedAttempt();
    afterRunLimit();
    s.activeOrgs.delete(ORG_A);

    expect(await recoverStalePublish(ORG_A, POST, 1)).toBe("organization_inactive");
    expect(post().publishStatus).toBe("PUBLISHING");
  });

  it("every write is scoped to the post's organization", async () => {
    interruptedAttempt();
    afterRunLimit();
    await recoverStalePublish(ORG_A, POST, 1);

    for (const [args] of db.creatorPost.updateMany.mock.calls as unknown as Array<
      [{ where: Where }]
    >) {
      expect(args.where).toMatchObject({ id: POST, organizationId: ORG_A });
    }
  });
});
