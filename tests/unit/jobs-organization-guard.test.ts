import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R2: queued jobs for a missing or soft-deleted organization skip (HTTP 200,
 * no retry) before any external or business effect, and stop before
 * persisting the result of a provider call during which the organization was
 * deleted. A guard database failure is an error (retry), never a skip.
 *
 * Synthetic data, a stateful in-memory fake, and mocked providers (no real
 * email, AI, embedding or social calls). "Deletion during a provider call" is
 * mocked sequencing: the provider mock deletes the organization before it
 * returns.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const MISSING = "99999999-9999-4999-8999-999999999999";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REM_A = "44444444-4444-4444-8444-444444444444";
const POST_A = "77777777-7777-4777-8777-777777777777";
const DOC_A = "55555555-5555-4555-8555-555555555555";
const DOC_B = "66666666-6666-4666-8666-666666666666";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  seq: 0,
  orgs: [] as Array<{ id: string; name: string; deletedAt: Date | null }>,
  failOrgLookup: false,
  reminders: [] as Row[],
  attendees: [] as Row[],
  events: [] as Row[],
  documents: [] as Row[],
  chunks: [] as Row[],
  notifications: [] as Row[],
  usage: [] as Row[],
  calls: [] as Row[],
  contacts: [] as Row[],
  activities: [] as Row[],
  posts: [] as Row[],
  assets: [] as Row[],
}));
const fx = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({})),
  embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
  anthropic: vi.fn(async () => ({
    content: [
      {
        type: "text",
        text: '{"summary":"Synthetic summary.","sentiment":"neutral","followUps":[]}',
      },
    ],
  })),
  publishPost: vi.fn(async () => ({ externalPostId: "ext-post-1" })),
  signUrl: vi.fn(async () => ({ data: { signedUrl: "https://storage.test/signed" }, error: null })),
  notifyUser: vi.fn(async () => undefined),
  recordUsage: vi.fn(async (orgId: string, metric: string, qty: number, meta: unknown) => {
    s.usage.push({ organizationId: orgId, metric, qty, metadata: meta });
  }),
  emitWorkflowEvent: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined),
}));

const id = (p: string) => `${p}-${++s.seq}`;
const org = (orgId: string) => s.orgs.find((o) => o.id === orgId);
const deleteOrg = (orgId: string) => {
  org(orgId)!.deletedAt = new Date();
};

const db = {
  organization: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      if (s.failOrgLookup) throw new Error("database unavailable");
      const o = org(where.id as string);
      return o && !o.deletedAt ? { id: o.id } : null;
    }),
  },
  reminder: {
    findUnique: vi.fn(async ({ where, include }: { where: Row; include?: Row }) => {
      const r = s.reminders.find((x) => x.id === where.id);
      if (!r) return null;
      if (!include) return { organizationId: r.organizationId };
      const e = s.events.find((x) => x.id === r.eventId)!;
      const o = org(e.organizationId as string)!;
      return {
        ...r,
        event: {
          ...e,
          attendeeRecords: s.attendees,
          booking: null,
          organization: { name: o.name, deletedAt: o.deletedAt },
        },
      };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const claimable =
        typeof where.status === "string"
          ? [where.status]
          : ((where.status as { in: string[] }).in ?? []);
      const r = s.reminders.find(
        (x) => x.id === where.id && claimable.includes(x.status as string),
      );
      if (!r) return { count: 0 };
      r.status = data.status;
      return { count: 1 };
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) =>
      Object.assign(
        s.reminders.find((x) => x.id === where.id)!,
        data,
      ),
    ),
  },
  document: {
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        s.documents.find(
          (d) => d.id === where.id && d.organizationId === where.organizationId && !d.deletedAt,
        ) ?? null,
    ),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) =>
      Object.assign(
        s.documents.find((d) => d.id === where.id)!,
        data,
      ),
    ),
    // The embed job's claim: PENDING/FAILED, or PROCESSING last updated before `lt`.
    // Its READY write: the claimed (PROCESSING), still existing document.
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const claimable = (d: Row) =>
        where.OR
          ? (where.OR as Row[]).some((c) =>
              typeof c.status === "string"
                ? d.status === c.status &&
                  (d.updatedAt as Date) < ((c.updatedAt as { lt: Date }).lt as Date)
                : (c.status as { in: string[] }).in.includes(d.status as string),
            )
          : d.status === where.status;
      const d = s.documents.find(
        (x) =>
          x.id === where.id &&
          x.organizationId === where.organizationId &&
          !x.deletedAt &&
          claimable(x),
      );
      if (!d) return { count: 0 };
      Object.assign(d, data);
      return { count: 1 };
    }),
  },
  documentChunk: {
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      s.chunks = s.chunks.filter((c) => c.documentId !== where.documentId);
      return { count: 0 };
    }),
  },
  // embed-document's chunk insert: the first bound value is the document id.
  $executeRaw: vi.fn(async (sql: { values?: unknown[] }) => {
    s.chunks.push({ documentId: sql.values?.[0] ?? "inserted", inserted: true });
    return 1;
  }),
  // Array form (embed-document's chunk inserts) and callback form (post-call's locked steps).
  $transaction: vi.fn(async (ops: unknown[] | ((tx: unknown) => Promise<unknown>)) =>
    typeof ops === "function" ? ops(db) : Promise.all(ops),
  ),
  notification: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      s.notifications.push(data);
      return data;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        s.notifications.find(
          (n) => n.organizationId === where.organizationId && n.href === where.href,
        ) ?? null,
    ),
  },
  voiceCall: {
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        s.calls.find(
          (c) => c.vapiCallId === where.vapiCallId && c.organizationId === where.organizationId,
        ) ?? null,
    ),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) =>
      Object.assign(
        s.calls.find((c) => c.id === where.id)!,
        data,
      ),
    ),
  },
  usageRecord: {
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        s.usage.find(
          (u) => u.organizationId === where.organizationId && u.metric === where.metric,
        ) ?? null,
    ),
  },
  contact: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: id("contact"), ...data };
      s.contacts.push(row);
      return row;
    }),
  },
  activity: {
    // The post-call job looks up the call's activity by metadata.voiceCallId.
    findFirst: vi.fn(
      async ({ where }: { where: Row & { metadata?: { equals?: unknown } } }) =>
        s.activities.find(
          (a) =>
            a.organizationId === where.organizationId &&
            (a.metadata as Row | undefined)?.voiceCallId === where.metadata?.equals,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      s.activities.push(data);
      return data;
    }),
  },
  organizationMember: {
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      where.organizationId === ORG_A || where.organizationId === ORG_B ? { userId: OWNER } : null,
    ),
  },
  creatorPost: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const p = s.posts.find((x) => x.id === where.id && x.organizationId === where.organizationId);
      return p ? { ...p } : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const p = s.posts.find(
        (x) =>
          x.id === where.id &&
          x.organizationId === where.organizationId &&
          (where.publishStatus as { in: string[] }).in.includes(x.publishStatus as string),
      );
      if (!p) return { count: 0 };
      p.publishStatus = data.publishStatus;
      return { count: 1 };
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) =>
      Object.assign(
        s.posts.find((x) => x.id === where.id)!,
        data,
      ),
    ),
    count: vi.fn(async () => 0),
  },
  creatorReferenceAsset: {
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      s.assets.filter(
        (a) =>
          (where.id as { in: string[] }).in.includes(a.id as string) &&
          a.organizationId === where.organizationId,
      ),
    ),
  },
};

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (r: Request) => r.text() }));
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
  tenantDb: vi.fn(),
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: fx.sendEmail }));
vi.mock("../../emails/booking-email", () => ({
  bookingEmailSubject: () => "Reminder",
  BookingEmail: () => null,
}));
vi.mock("@/server/integrations/openai", () => ({ embed: fx.embed }));
vi.mock("@/server/ai/extract", () => ({ extractText: vi.fn(), extractFromUrl: vi.fn() }));
vi.mock("@/server/ai/chunking", () => ({
  chunkText: (text: string) =>
    text.split("|").map((content, index) => ({ index, content, tokenCount: 3 })),
}));
vi.mock("@/server/security/document-ingestion", async (importActual) => ({
  DocumentIngestionError: (await importActual<{ DocumentIngestionError: unknown }>())
    .DocumentIngestionError,
  assertExtractionLimits: () => undefined,
  assertTenantStoragePath: () => undefined,
  verifyUploadObject: () => undefined,
}));
vi.mock("@/server/services/billing/entitlements", () => ({ recordUsage: fx.recordUsage }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: fx.anthropic } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 100 }) }));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: fx.emitWorkflowEvent }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ storage: { from: () => ({ createSignedUrl: fx.signUrl }) } }),
}));
vi.mock("@/server/social", () => ({
  getSocialPublishingProvider: () => ({ publishPost: fx.publishPost }),
}));
vi.mock("@/server/integrations/social/crypto", () => ({ decryptSocialToken: () => "token" }));
vi.mock("@/server/services/audit", () => ({ audit: fx.audit }));
vi.mock("@/server/services/creator-notifications", () => ({ notifyUser: fx.notifyUser }));

// Loaded up front: the routes import the guard and the (mocked) tenant module
// concurrently, and a first-time concurrent dynamic import of a mocked module
// can resolve the real one in Vitest. Production code has no such mocks.
import "@/server/jobs/organization-guard";
import { POST as sendReminder } from "@/app/api/v1/jobs/send-reminder/route";
import { POST as embedDocument } from "@/app/api/v1/jobs/embed-document/route";
import { POST as postCall } from "@/app/api/v1/jobs/post-call/route";
import { POST as publishPost } from "@/app/api/v1/jobs/publish-creator-post/route";

const job = (body: Row) =>
  new Request("https://jobs.test/api/v1/jobs", { method: "POST", body: JSON.stringify(body) });
const SKIPPED = { skipped: "organization_inactive" };

beforeEach(() => {
  vi.clearAllMocks();
  s.seq = 0;
  s.failOrgLookup = false;
  s.orgs = [
    { id: ORG_A, name: "Org A", deletedAt: null },
    { id: ORG_B, name: "Org B", deletedAt: null },
  ];
  s.events = [
    {
      id: "evt-a",
      organizationId: ORG_A,
      title: "Synthetic meeting",
      status: "CONFIRMED",
      deletedAt: null,
      timezone: "Europe/Helsinki",
      startsAt: new Date("2026-11-02T09:00:00Z"),
      location: null,
    },
  ];
  s.reminders = [{ id: REM_A, organizationId: ORG_A, eventId: "evt-a", status: "SCHEDULED" }];
  s.attendees = [{ email: "attendee@example.test", name: "Attendee" }];
  s.documents = [
    {
      id: DOC_A,
      organizationId: ORG_A,
      title: "Synthetic doc",
      status: "PENDING",
      uploadedById: OWNER,
      deletedAt: null,
    },
    {
      id: DOC_B,
      organizationId: ORG_B,
      title: "Other org doc",
      status: "PENDING",
      uploadedById: OWNER,
      deletedAt: null,
    },
  ];
  s.chunks = [];
  s.notifications = [];
  s.usage = [];
  s.calls = [
    {
      id: "call-a",
      vapiCallId: "vapi-a",
      organizationId: ORG_A,
      durationSeconds: 120,
      callerNumber: "+358 40 000 0000",
      status: "COMPLETED",
      transcript: [{ role: "user", text: "Synthetic transcript content" }],
      summary: null,
      contactId: null,
      postCallProcessedAt: null,
      assistant: { name: "Synthetic assistant", language: "EN" },
    },
  ];
  s.contacts = [];
  s.activities = [];
  s.assets = [
    {
      id: "asset-a",
      organizationId: ORG_A,
      storagePath: `${ORG_A}/x.png`,
      assetType: "image",
      source: "UPLOAD",
    },
  ];
  s.posts = [
    {
      id: POST_A,
      organizationId: ORG_A,
      createdById: OWNER,
      platform: "INSTAGRAM",
      publishStatus: "SCHEDULED",
      approvalStatus: "APPROVED",
      contentVersion: 1,
      approvedContentVersion: 1,
      campaign: null,
      campaignId: null,
      caption: "Synthetic caption",
      hashtags: [],
      assetIds: ["asset-a"],
      socialAccount: {
        id: "acct-a",
        organizationId: ORG_A,
        status: "CONNECTED",
        accessTokenEnc: "enc",
        externalAccountId: "ext-a",
      },
    },
  ];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── send-reminder ──────────────────────────────────────────────────────────
describe("send-reminder", () => {
  const send = () => sendReminder(job({ reminderId: REM_A }));
  const reminder = () => s.reminders.find((r) => r.id === REM_A)!;

  it("active organization: sends and marks the reminder SENT (unchanged behavior)", async () => {
    expect(await (await send()).json()).toEqual({ sent: 1, failed: 0 });
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    expect(reminder().status).toBe("SENT");
  });

  it("soft-deleted organization: 200 skip, no email, reminder left SCHEDULED", async () => {
    deleteOrg(ORG_A);
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SKIPPED);
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(reminder().status).toBe("SCHEDULED");
  });

  it("organization deleted after the check, before sending: no email", async () => {
    // The org is read as active, then deleted before the event is loaded.
    db.organization.findFirst.mockImplementationOnce(async () => {
      const result = { id: ORG_A };
      deleteOrg(ORG_A);
      return result;
    });
    expect(await (await send()).json()).toEqual(SKIPPED);
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("an event of another organization (inconsistent data) sends nothing", async () => {
    s.events[0]!.organizationId = ORG_B;
    expect(await (await send()).json()).toEqual(SKIPPED);
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("redelivery: a skipped reminder is skipped again; a sent one is never resent", async () => {
    deleteOrg(ORG_A);
    await send();
    await send();
    expect(fx.sendEmail).not.toHaveBeenCalled();
    org(ORG_A)!.deletedAt = null;
    await send();
    await send();
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("guard database failure: the job fails (retry), nothing claimed or sent", async () => {
    s.failOrgLookup = true;
    await expect(send()).rejects.toThrow("database unavailable");
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(reminder().status).toBe("SCHEDULED");
  });
});

describe("send-reminder — delivery failures are recorded, never silent", () => {
  const send = () => sendReminder(job({ reminderId: REM_A }));
  const reminder = () => s.reminders.find((r) => r.id === REM_A)!;
  const errorLogs = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

  it("sends to every recipient and reports the count (unchanged behavior)", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0 });
    expect(reminder().status).toBe("SENT");
  });

  it("nobody reached: FAILED with a reason, logged without the address, and 500 for a retry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fx.sendEmail.mockRejectedValueOnce(
      Object.assign(new Error("502 from provider for attendee@example.test"), {
        name: "ResendError",
      }),
    );

    const res = await send();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "send failed", sent: 0, failed: 1 });
    expect(reminder().status).toBe("FAILED");
    expect(reminder().lastError).toBe("email delivery failed: ResendError");
    const logged = errorLogs(error).filter((l) => l.event === "reminder_email_failed");
    expect(logged).toEqual([
      {
        event: "reminder_email_failed",
        reminderId: REM_A,
        eventId: "evt-a",
        orgId: ORG_A,
        name: "ResendError",
      },
    ]);
    expect(JSON.stringify(error.mock.calls)).not.toContain("attendee@example.test");
    expect(JSON.stringify(error.mock.calls)).not.toContain("502 from provider");
    error.mockRestore();
  });

  it("a failed reminder is sent by the retry; a sent one is still never resent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fx.sendEmail.mockRejectedValueOnce(new Error("provider down"));
    expect((await send()).status).toBe(500);
    expect(reminder().status).toBe("FAILED");

    const retry = await send();

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ sent: 1, failed: 0 });
    expect(reminder().status).toBe("SENT");
    expect(fx.sendEmail).toHaveBeenCalledTimes(2);
    await send();
    expect(fx.sendEmail).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("some reached: stays SENT (never resent), the failures are logged and counted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Two attendees: the first send fails, the second succeeds.
    s.attendees = [
      { email: "first@example.test", name: "First" },
      { email: "second@example.test", name: "Second" },
    ];
    fx.sendEmail.mockRejectedValueOnce(new Error("provider down"));

    const res = await send();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 1 });
    expect(reminder().status).toBe("SENT");
    expect(errorLogs(error).filter((l) => l.event === "reminder_email_failed")).toHaveLength(1);
    await send();
    expect(fx.sendEmail).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

// ── embed-document ─────────────────────────────────────────────────────────
describe("embed-document", () => {
  const embedJob = (orgId = ORG_A, documentId = DOC_A) =>
    embedDocument(job({ documentId, orgId, inlineContent: "one|two|three" }));
  const doc = (docId = DOC_A) => s.documents.find((d) => d.id === docId)!;

  it("active organization: embeds, stores chunks, READY, usage and notification (unchanged)", async () => {
    expect(await (await embedJob()).json()).toEqual({ ok: true, chunks: 3 });
    expect(fx.embed).toHaveBeenCalledTimes(1);
    expect(s.chunks).toHaveLength(3);
    expect(doc().status).toBe("READY");
    expect(fx.recordUsage).toHaveBeenCalledTimes(1);
    expect(s.notifications).toHaveLength(1);
  });

  it.each([
    ["soft-deleted", () => deleteOrg(ORG_A), ORG_A],
    ["missing", () => undefined, MISSING],
  ])("%s organization: 200 skip, no embedding call, no writes", async (_, setup, orgId) => {
    setup();
    const res = await embedJob(orgId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SKIPPED);
    expect(fx.embed).not.toHaveBeenCalled();
    expect(doc().status).toBe("PENDING");
    expect(s.chunks).toHaveLength(0);
  });

  it("another organization's document can't be embedded via this org (existing scoping)", async () => {
    expect(await (await embedJob(ORG_A, DOC_B)).json()).toEqual({ skipped: "document gone" });
    expect(fx.embed).not.toHaveBeenCalled();
    expect(doc(DOC_B).status).toBe("PENDING");
  });

  it("organization deleted during the embedding call: no chunks stored, not READY, no usage or notification", async () => {
    fx.embed.mockImplementationOnce(async (texts: string[]) => {
      deleteOrg(ORG_A);
      return texts.map(() => [0.1]);
    });
    expect(await (await embedJob()).json()).toEqual(SKIPPED);
    expect(fx.embed).toHaveBeenCalledTimes(1); // the in-flight call can't be recalled
    expect(s.chunks).toHaveLength(0);
    expect(doc().status).not.toBe("READY");
    expect(fx.recordUsage).not.toHaveBeenCalled();
    expect(s.notifications).toHaveLength(0);
  });

  it("document deleted during the embedding call: its new chunks are removed, never READY, no usage or notification", async () => {
    fx.embed.mockImplementationOnce(async (texts: string[]) => {
      // deleteDocument(): soft delete and remove the chunks it knows of.
      doc().deletedAt = new Date();
      s.chunks = s.chunks.filter((c) => c.documentId !== DOC_A);
      return texts.map(() => [0.1]);
    });

    const res = await embedJob();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "document gone" });
    expect(s.chunks).toHaveLength(0);
    expect(doc().status).toBe("PROCESSING");
    expect(doc().deletedAt).not.toBeNull();
    expect(fx.recordUsage).not.toHaveBeenCalled();
    expect(s.notifications).toHaveLength(0);
  });

  it("guard database failure: the job fails (retry), no embedding call", async () => {
    s.failOrgLookup = true;
    await expect(embedJob()).rejects.toThrow("database unavailable");
    expect(fx.embed).not.toHaveBeenCalled();
  });

  it("redelivery after a skip is skipped again", async () => {
    deleteOrg(ORG_A);
    await embedJob();
    await embedJob();
    expect(fx.embed).not.toHaveBeenCalled();
  });
});

/**
 * A document's status and error are what its owner sees on the Knowledge page
 * (document-table.tsx renders `error` verbatim). They must say what happened without
 * exposing provider or database detail (CLAUDE.md §4), the failure must reach the
 * logs (ids and error class only), and a document whose chunks are all stored must
 * not be reported as failed because a later bookkeeping step failed.
 */
describe("embed-document — failures are truthful and safe", () => {
  const embedJob = (inlineContent = "one|two|three") =>
    embedDocument(job({ documentId: DOC_A, orgId: ORG_A, inlineContent }));
  const doc = () => s.documents.find((d) => d.id === DOC_A)!;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());
  const logged = () => errorSpy.mock.calls.flat().map(String).join("\n");

  it("a provider error is stored and notified as a generic message, and logged without its text", async () => {
    fx.embed.mockRejectedValueOnce(
      new Error(
        "401 provider rejected request PROVIDER-INTERNAL-DETAIL at https://api.openai.com/v1",
      ),
    );

    const res = await embedJob();

    expect(res.status).toBe(200);
    expect(doc().status).toBe("FAILED");
    expect(doc().error).toBe("Processing failed. Please try again.");
    const failed = s.notifications.find((n) => n.type === "document.failed")!;
    expect(failed.body).toBe("Processing failed. Please try again.");
    expect(JSON.stringify(await res.json())).not.toContain("PROVIDER-INTERNAL-DETAIL");
    expect(JSON.parse(logged())).toEqual({
      event: "document_embed_failed",
      orgId: ORG_A,
      documentId: DOC_A,
      name: "Error",
    });
    expect(logged()).not.toContain("PROVIDER-INTERNAL-DETAIL");
  });

  const failUrlExtraction = async (err: Error) => {
    const { extractFromUrl } = await import("@/server/ai/extract");
    vi.mocked(extractFromUrl).mockRejectedValueOnce(err);
    Object.assign(doc(), { sourceType: "URL", sourceUrl: "https://intranet.example/doc" });
    await embedDocument(job({ documentId: DOC_A, orgId: ORG_A }));
    expect(doc().status).toBe("FAILED");
  };

  it("a reason written for the user is kept: a blocked URL says so", async () => {
    const { UrlIngestionError } = await import("@/server/security/url-ingestion");

    await failUrlExtraction(
      new UrlIngestionError("blocked_destination", "URL destination is not public"),
    );

    expect(doc().error).toBe("URL destination is not public");
  });

  it("a parser failure doesn't show the PDF library's own message", async () => {
    const { ParserSecurityError } = await import("@/server/security/parser-security");

    await failUrlExtraction(
      new ParserSecurityError(
        "parser_failed",
        "ENOENT: no such file or directory, open '/var/task/node_modules/pdf-parse/PARSER-INTERNAL-DETAIL'",
      ),
    );

    expect(doc().error).toBe("The document could not be read.");
    expect(JSON.stringify(s.notifications)).not.toContain("PARSER-INTERNAL-DETAIL");
  });

  it("an error that only borrows an owner-facing name is not trusted", async () => {
    await failUrlExtraction(
      Object.assign(new Error("upstream detail PROVIDER-INTERNAL-DETAIL"), {
        name: "UrlIngestionError",
      }),
    );

    expect(doc().error).toBe("Processing failed. Please try again.");
  });

  it("usage recording failing after the chunks are stored leaves the document READY", async () => {
    fx.recordUsage.mockRejectedValueOnce(new Error("connection terminated"));

    const res = await embedJob();

    expect(await res.json()).toEqual({ ok: true, chunks: 3 });
    expect(doc().status).toBe("READY");
    expect(doc().error ?? null).toBeNull();
    expect(s.notifications.map((n) => n.type)).toEqual(["document.ready"]);
    expect(logged()).toContain("document_embed_usage_failed");
  });
});

/**
 * QStash can deliver an embed job again while or after a run works on it. Only the
 * delivery that claims the document replaces its chunks and pays for embeddings; a
 * finished document is not redone; a run the platform stopped (timeout, out of memory)
 * left the document PROCESSING, and a later delivery takes it over instead of leaving
 * it stuck.
 */
describe("embed-document — one run at a time, nothing left stuck", () => {
  const embedJob = (orgId = ORG_A, documentId = DOC_A) =>
    embedDocument(job({ documentId, orgId, inlineContent: "one|two|three" }));
  const doc = (docId = DOC_A) => s.documents.find((d) => d.id === docId)!;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it("a redelivery after the document is READY does nothing: no paid call, chunks kept", async () => {
    await embedJob();
    const chunksAfterFirstRun = [...s.chunks];
    vi.clearAllMocks();

    const res = await embedJob();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "already processed" });
    expect(fx.embed).not.toHaveBeenCalled();
    expect(db.documentChunk.deleteMany).not.toHaveBeenCalled();
    expect(s.chunks).toEqual(chunksAfterFirstRun);
    expect(doc().status).toBe("READY");
    expect(fx.recordUsage).not.toHaveBeenCalled();
    expect(s.notifications.filter((n) => n.type === "document.ready")).toHaveLength(1);
  });

  it("a second delivery during a run is refused for a retry (409), and the run's chunks aren't duplicated", async () => {
    let release!: () => void;
    fx.embed.mockImplementationOnce(async (texts: string[]) => {
      await new Promise<void>((r) => (release = r));
      return texts.map(() => [0.1]);
    });

    const first = embedJob();
    await vi.waitFor(() => expect(fx.embed).toHaveBeenCalledTimes(1));
    const second = await embedJob();
    release();
    const done = await first;

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "processing_in_progress" });
    expect(fx.embed).toHaveBeenCalledTimes(1);
    expect(db.documentChunk.deleteMany).toHaveBeenCalledTimes(1);
    expect(await done.json()).toEqual({ ok: true, chunks: 3 });
    expect(s.chunks).toHaveLength(3);
    expect(doc().status).toBe("READY");
  });

  it("a PROCESSING claim within the reclaim window is left to its run (409, nothing done)", async () => {
    Object.assign(doc(), { status: "PROCESSING", updatedAt: minutesAgo(5) });

    const res = await embedJob();

    expect(res.status).toBe(409);
    expect(fx.embed).not.toHaveBeenCalled();
    expect(db.documentChunk.deleteMany).not.toHaveBeenCalled();
    expect(doc().status).toBe("PROCESSING");
  });

  it("a run the platform stopped is taken over: stale PROCESSING becomes READY, old partial chunks replaced", async () => {
    Object.assign(doc(), { status: "PROCESSING", updatedAt: minutesAgo(8) });
    s.chunks = [{ documentId: DOC_A }, { documentId: DOC_A }]; // left by the stopped run

    const res = await embedJob();

    expect(await res.json()).toEqual({ ok: true, chunks: 3 });
    expect(doc().status).toBe("READY");
    expect(s.chunks).toHaveLength(3);
    expect(s.chunks.filter((c) => !c.inserted)).toHaveLength(0);
  });

  it("a FAILED document is processed again by a later delivery", async () => {
    Object.assign(doc(), { status: "FAILED", error: "Processing failed. Please try again." });

    expect(await (await embedJob()).json()).toEqual({ ok: true, chunks: 3 });
    expect(doc().status).toBe("READY");
    expect(doc().error).toBeNull();
  });

  it("the claim marks the document PROCESSING with a fresh timestamp, scoped to its organization", async () => {
    const before = Date.now();
    fx.embed.mockImplementationOnce(async (texts: string[]) => {
      expect(doc().status).toBe("PROCESSING");
      expect((doc().updatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      return texts.map(() => [0.1]);
    });

    await embedJob();

    expect(db.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: DOC_A, organizationId: ORG_A, deletedAt: null }),
      }),
    );
  });

  it("another organization's document is never claimed through this org", async () => {
    expect(await (await embedJob(ORG_A, DOC_B)).json()).toEqual({ skipped: "document gone" });
    expect(db.document.updateMany).not.toHaveBeenCalled();
    expect(doc(DOC_B).status).toBe("PENDING");
  });

  it("a document deleted just before the claim is skipped, not processed", async () => {
    db.document.updateMany.mockImplementationOnce(async () => {
      doc().deletedAt = new Date();
      return { count: 0 };
    });

    const res = await embedJob();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "document gone" });
    expect(fx.embed).not.toHaveBeenCalled();
  });
});

// ── post-call ──────────────────────────────────────────────────────────────
describe("post-call", () => {
  const run = (orgId = ORG_A) => postCall(job({ vapiCallId: "vapi-a", orgId }));
  const call = () => s.calls.find((c) => c.id === "call-a")!;
  // The workflow events emitted, by type: a contact the run creates emits `contact.created`.
  const emitted = () =>
    (fx.emitWorkflowEvent.mock.calls as unknown as unknown[][]).map((args) => args[1]);

  it("active organization: usage, contact, summary, activity, notification, workflow, processed (unchanged)", async () => {
    expect(await (await run()).json()).toEqual({ ok: true });
    expect(fx.recordUsage).toHaveBeenCalledTimes(1);
    expect(s.contacts).toHaveLength(1);
    expect(fx.anthropic).toHaveBeenCalledTimes(1);
    expect(call().summary).toBe("Synthetic summary.");
    expect(s.activities).toHaveLength(1);
    expect(s.notifications).toHaveLength(1);
    expect(emitted()).toEqual(["contact.created", "call.completed"]);
    expect(call().postCallProcessedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["soft-deleted", () => deleteOrg(ORG_A), ORG_A],
    ["missing", () => undefined, MISSING],
  ])("%s organization: 200 skip, no usage, contact, AI call or events", async (_, setup, orgId) => {
    setup();
    const res = await run(orgId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SKIPPED);
    expect(fx.recordUsage).not.toHaveBeenCalled();
    expect(fx.anthropic).not.toHaveBeenCalled();
    expect(s.contacts).toHaveLength(0);
    expect(fx.emitWorkflowEvent).not.toHaveBeenCalled();
    expect(call().postCallProcessedAt).toBeNull();
  });

  it("a call of another organization can't be processed via this org (existing scoping)", async () => {
    expect(await (await run(ORG_B)).json()).toEqual({ skipped: "call not found" });
    expect(fx.anthropic).not.toHaveBeenCalled();
  });

  it("organization deleted during the summary call: nothing persisted after it", async () => {
    fx.anthropic.mockImplementationOnce(async () => {
      deleteOrg(ORG_A);
      return {
        content: [{ type: "text", text: '{"summary":"x","sentiment":"neutral","followUps":[]}' }],
      };
    });
    expect(await (await run()).json()).toEqual(SKIPPED);
    expect(call().summary).toBeNull();
    expect(s.activities).toHaveLength(0);
    expect(s.notifications).toHaveLength(0);
    // The contact was committed before the summary call; nothing after it is emitted.
    expect(emitted()).toEqual(["contact.created"]);
    expect(call().postCallProcessedAt).toBeNull();
  });

  it("guard database failure: the job fails (retry), no usage or AI call", async () => {
    s.failOrgLookup = true;
    await expect(run()).rejects.toThrow("database unavailable");
    expect(fx.recordUsage).not.toHaveBeenCalled();
    expect(fx.anthropic).not.toHaveBeenCalled();
  });

  it("redelivery: skipped while deleted; processed once when active", async () => {
    deleteOrg(ORG_A);
    await run();
    expect(fx.anthropic).not.toHaveBeenCalled();
    org(ORG_A)!.deletedAt = null;
    await run();
    await run();
    expect(fx.anthropic).toHaveBeenCalledTimes(1);
    expect(emitted()).toEqual(["contact.created", "call.completed"]);
  });
});

// ── publish-creator-post ───────────────────────────────────────────────────
describe("publish-creator-post", () => {
  const publish = (orgId = ORG_A) => publishPost(job({ orgId, postId: POST_A }));
  const post = () => s.posts.find((p) => p.id === POST_A)!;

  it("active organization: publishes once, records it, notifies (unchanged)", async () => {
    expect(await (await publish()).json()).toEqual({ ok: true });
    expect(fx.publishPost).toHaveBeenCalledTimes(1);
    expect(post()).toMatchObject({ publishStatus: "PUBLISHED", externalPostId: "ext-post-1" });
    expect(fx.notifyUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["soft-deleted", () => deleteOrg(ORG_A), ORG_A],
    ["missing", () => undefined, MISSING],
  ])(
    "%s organization: 200 skip, nothing signed or published, status unchanged",
    async (_, setup, orgId) => {
      setup();
      const res = await publish(orgId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(SKIPPED);
      expect(fx.publishPost).not.toHaveBeenCalled();
      expect(fx.signUrl).not.toHaveBeenCalled();
      expect(post().publishStatus).toBe("SCHEDULED");
    },
  );

  it("another organization's social account can't publish this post", async () => {
    (post().socialAccount as Row).organizationId = ORG_B;
    // A refusal is final: answered 200 (no retry), recorded on the post.
    const res = await publish();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, code: "social_account_not_connected" });
    expect(fx.publishPost).not.toHaveBeenCalled();
    expect(post()).toMatchObject({
      publishStatus: "FAILED",
      lastErrorCode: "social_account_not_connected",
    });
  });

  it("another organization's post can't be published via this org (existing scoping)", async () => {
    const res = await publish(ORG_B);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, code: "post_not_found" });
    expect(fx.publishPost).not.toHaveBeenCalled();
  });

  it("organization deleted after the claim, before the provider call: not published, no notification, no retry", async () => {
    fx.signUrl.mockImplementationOnce(async () => {
      deleteOrg(ORG_A);
      return { data: { signedUrl: "https://storage.test/signed" }, error: null };
    });
    const res = await publish();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SKIPPED);
    expect(fx.publishPost).not.toHaveBeenCalled();
    expect(post()).toMatchObject({
      publishStatus: "FAILED",
      lastErrorCode: "organization_inactive",
    });
    expect(fx.notifyUser).not.toHaveBeenCalled();
  });

  it("organization deleted during the provider call: the post is live (recorded), nobody notified", async () => {
    fx.publishPost.mockImplementationOnce(async () => {
      deleteOrg(ORG_A);
      return { externalPostId: "ext-post-late" };
    });
    expect((await publish()).status).toBe(200);
    expect(fx.publishPost).toHaveBeenCalledTimes(1); // can't be recalled
    expect(post()).toMatchObject({ publishStatus: "PUBLISHED", externalPostId: "ext-post-late" });
    expect(fx.notifyUser).not.toHaveBeenCalled();
  });

  it("guard database failure: the job fails (retry), nothing claimed or published", async () => {
    s.failOrgLookup = true;
    expect((await publish()).status).toBe(500);
    expect(fx.publishPost).not.toHaveBeenCalled();
    expect(post().publishStatus).toBe("SCHEDULED");
  });

  it("redelivery: skipped while deleted; published once when active", async () => {
    deleteOrg(ORG_A);
    await publish();
    org(ORG_A)!.deletedAt = null;
    await publish();
    await publish();
    expect(fx.publishPost).toHaveBeenCalledTimes(1);
  });
});

// ── malformed bodies ───────────────────────────────────────────────────────
describe("a malformed job body is refused (400), never retried into the dead-letter queue", () => {
  const malformed = (body: string) =>
    new Request("https://jobs.test/api/v1/jobs", { method: "POST", body });

  it.each([
    ["send-reminder", sendReminder],
    ["embed-document", embedDocument],
    ["post-call", postCall],
    ["publish-creator-post", publishPost],
  ])("%s", async (_name, handler) => {
    for (const body of ["not json", "{", ""]) {
      const res = await handler(malformed(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid payload" });
    }
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(fx.embed).not.toHaveBeenCalled();
    expect(fx.anthropic).not.toHaveBeenCalled();
    expect(fx.publishPost).not.toHaveBeenCalled();
    expect(db.organization.findFirst).not.toHaveBeenCalled();
  });
});
