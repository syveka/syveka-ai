import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CallRow = {
  id: string;
  vapiCallId: string;
  organizationId: string;
  contactId: string | null;
  callerNumber: string;
  status: string;
  durationSeconds: number;
  transcript: unknown;
  summary: string | null;
  sentiment: string | null;
  postCallProcessedAt: Date | null;
  assistant: { name: string; language: string };
};

const ORG_ID = "11111111-1111-1111-1111-111111111111";

function freshCallRow(): CallRow {
  return {
    id: "call-row-1",
    vapiCallId: "call-1",
    organizationId: ORG_ID,
    contactId: null,
    callerNumber: "+358401234567",
    status: "COMPLETED",
    durationSeconds: 90,
    transcript: [{ role: "user", text: "hello, do you have the strawberry toy?" }],
    summary: null,
    sentiment: null,
    postCallProcessedAt: null,
    assistant: { name: "Fruppi Assistant", language: "EN" },
  };
}

const locks = vi.hoisted(() => {
  const held = new Map<string, Promise<void>>();
  const locks = {
    statements: [] as string[],
    /** Waits until no other holder has `key`, then holds it; returns the release. */
    onContention: undefined as (() => void) | undefined,
    acquire: async (key: string): Promise<() => void> => {
      if (held.has(key)) locks.onContention?.();
      while (held.has(key)) await held.get(key);
      let release = () => {};
      held.set(key, new Promise<void>((resolve) => (release = resolve)));
      return () => {
        held.delete(key);
        release();
      };
    },
  };
  return locks;
});

const mocks = vi.hoisted(() => ({
  verifyJobRequest: vi.fn(async (req: Request): Promise<string | null> => await req.text()),
  voiceCallFindFirst: vi.fn(async (): Promise<unknown> => null),
  voiceCallUpdate: vi.fn(async (..._args: unknown[]) => ({})),
  usageRecordFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  // The contact lookup by phone (a raw query): the matching contacts, at most two.
  contactMatches: vi.fn(async (..._args: unknown[]): Promise<{ id: string }[]> => []),
  contactCreate: vi.fn(async () => ({ id: "contact-new-1" })),
  activityCreate: vi.fn(async () => ({ id: "activity-1" })),
  activityFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  organizationMemberFindFirst: vi.fn(async () => ({ userId: "owner-1" })),
  notificationFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  notificationCreate: vi.fn(async () => ({ id: "notif-1" })),
  recordUsage: vi.fn(async (..._args: unknown[]) => {}),
  emitWorkflowEvent: vi.fn(async (..._args: unknown[]) => {}),
  anthropicCreate: vi.fn(async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          summary: "Caller asked about the strawberry toy.",
          sentiment: "positive",
          followUps: ["Send catalog link"],
        }),
      },
    ],
  })),
}));

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: mocks.verifyJobRequest }));
// The organization is active (inactive/missing organizations are covered in
// jobs-organization-guard.test.ts).
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: vi.fn(async () => true),
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/db/tenant", () => {
  const client: Record<string, unknown> = {
    voiceCall: { findFirst: mocks.voiceCallFindFirst, update: mocks.voiceCallUpdate },
    usageRecord: { findFirst: mocks.usageRecordFindFirst },
    contact: { create: mocks.contactCreate },
    $queryRaw: mocks.contactMatches,
    activity: { create: mocks.activityCreate, findFirst: mocks.activityFindFirst },
    organizationMember: { findFirst: mocks.organizationMemberFindFirst },
    notification: { findFirst: mocks.notificationFindFirst, create: mocks.notificationCreate },
  };
  // Advisory locks are modelled as one mutex per lock key, held until the transaction ends.
  // Every lock a transaction takes is held until it ends, as with pg_advisory_xact_lock.
  client.$transaction = async (step: (tx: unknown) => Promise<unknown>) => {
    const releases: Array<() => void> = [];
    const tx = {
      ...client,
      $executeRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
        locks.statements.push(sql.join("?"));
        releases.push(await locks.acquire(String(values.join(":"))));
        return 1;
      },
    };
    try {
      return await step(tx);
    } finally {
      for (const release of releases) release();
    }
  };
  return { unscopedPrisma: client };
});
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: mocks.anthropicCreate } },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: () => ({ model: "claude-haiku", maxTokens: 512 }),
}));
vi.mock("@/server/services/billing/entitlements", () => ({ recordUsage: mocks.recordUsage }));
vi.mock("@/server/services/workflow-events", () => ({
  emitWorkflowEvent: mocks.emitWorkflowEvent,
}));

import { POST } from "@/app/api/v1/jobs/post-call/route";

function jobRequest() {
  return new Request("http://localhost/api/v1/jobs/post-call", {
    method: "POST",
    body: JSON.stringify({ vapiCallId: "call-1", orgId: ORG_ID }),
  });
}

type UpdateCall = [{ where: { id: string }; data: Record<string, unknown> }];

beforeEach(() => {
  vi.clearAllMocks();
  locks.statements.length = 0;
  locks.onContention = undefined;
  mocks.verifyJobRequest.mockImplementation(async (req: Request) => await req.text());
  mocks.voiceCallFindFirst.mockResolvedValue(freshCallRow());
  mocks.usageRecordFindFirst.mockResolvedValue(null);
  mocks.contactMatches.mockResolvedValue([]);
  mocks.notificationFindFirst.mockResolvedValue(null);
  mocks.activityFindFirst.mockResolvedValue(null);
});

describe("post-call job — workflow event", () => {
  it("reports the sentiment computed by this run, not the value loaded before it", async () => {
    await POST(jobRequest());

    expect(mocks.emitWorkflowEvent).toHaveBeenCalledWith(
      ORG_ID,
      "call.completed",
      expect.objectContaining({ sentiment: "positive" }),
      expect.anything(),
    );
  });
});

describe("post-call job — contact.created workflow event", () => {
  const contactCreatedCalls = () =>
    (mocks.emitWorkflowEvent.mock.calls as unknown as unknown[][]).filter(
      (args) => args[1] === "contact.created",
    );

  it("a contact the call creates emits contact.created once, for this organization, keyed by the contact id", async () => {
    await POST(jobRequest());

    const calls = contactCreatedCalls();
    expect(calls).toHaveLength(1);
    const [orgId, , data, sourceEventId] = calls[0]!;
    expect(orgId).toBe(ORG_ID);
    expect(data).toMatchObject({ contactId: "contact-new-1" });
    expect(sourceEventId).toBe("contact-new-1");
  });

  it("a caller matched to an existing contact emits no contact.created", async () => {
    mocks.contactMatches.mockResolvedValue([{ id: "contact-existing-1" }]);

    await POST(jobRequest());

    expect(mocks.contactCreate).not.toHaveBeenCalled();
    expect(contactCreatedCalls()).toEqual([]);
  });

  it("a retry after the contact step committed creates and emits nothing again", async () => {
    // A prior attempt created and linked the contact, then failed before the marker.
    mocks.voiceCallFindFirst.mockResolvedValue({ ...freshCallRow(), contactId: "contact-new-1" });

    await POST(jobRequest());

    expect(mocks.contactCreate).not.toHaveBeenCalled();
    expect(contactCreatedCalls()).toEqual([]);
  });

  it("a failing workflow queue never fails the job or loses the saved contact", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.emitWorkflowEvent.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "contact.created") throw new Error("queue unavailable");
    });

    const response = await POST(jobRequest());

    expect(response.status).toBe(200);
    expect(mocks.contactCreate).toHaveBeenCalledTimes(1);
    const marked = (mocks.voiceCallUpdate.mock.calls as UpdateCall[]).some(
      ([args]) => "postCallProcessedAt" in args.data,
    );
    expect(marked).toBe(true);
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("contact_created_workflow_event_failed");
    expect(logged).not.toContain("+358");
    mocks.emitWorkflowEvent.mockImplementation(async () => {});
    errorSpy.mockRestore();
  });
});

describe("post-call job — idempotency against QStash-level retry", () => {
  it("first invocation: runs every step and marks the call processed at the end", async () => {
    const response = await POST(jobRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
    expect(mocks.contactCreate).toHaveBeenCalledTimes(1);
    expect(mocks.activityCreate).toHaveBeenCalledTimes(1);
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);
    // The new contact's `contact.created`, then `call.completed`: one each.
    expect(mocks.emitWorkflowEvent.mock.calls.map((args) => args[1])).toEqual([
      "contact.created",
      "call.completed",
    ]);

    // The completion marker must be the last write, using the row's own id.
    const calls = mocks.voiceCallUpdate.mock.calls as UpdateCall[];
    const markerCall = calls.find(([args]) => "postCallProcessedAt" in args.data);
    expect(markerCall).toBeDefined();
    expect(markerCall![0].where).toEqual({ id: "call-row-1" });
    expect(markerCall![0].data.postCallProcessedAt).toBeInstanceOf(Date);
  });

  it("retried invocation (already processed): short-circuits before any side effect runs again", async () => {
    mocks.voiceCallFindFirst.mockResolvedValue({
      ...freshCallRow(),
      contactId: "contact-existing-1",
      sentiment: "positive",
      postCallProcessedAt: new Date("2026-08-30T10:00:00Z"),
    });

    const response = await POST(jobRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, alreadyProcessed: true });

    expect(mocks.recordUsage).not.toHaveBeenCalled();
    expect(mocks.contactCreate).not.toHaveBeenCalled();
    expect(mocks.activityCreate).not.toHaveBeenCalled();
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
    expect(mocks.emitWorkflowEvent).not.toHaveBeenCalled();
    expect(mocks.voiceCallUpdate).not.toHaveBeenCalled();
  });

  it("existing contact by phone: matches instead of creating a duplicate", async () => {
    mocks.contactMatches.mockResolvedValue([{ id: "contact-existing-2" }]);
    const response = await POST(jobRequest());
    expect(response.status).toBe(200);

    expect(mocks.contactCreate).not.toHaveBeenCalled();
    const calls = mocks.voiceCallUpdate.mock.calls as UpdateCall[];
    const contactLinkCall = calls.find(([args]) => args.data.contactId === "contact-existing-2");
    expect(contactLinkCall).toBeDefined();
  });

  it("invalid signature: rejected before any database read", async () => {
    mocks.verifyJobRequest.mockResolvedValue(null);
    const response = await POST(jobRequest());
    expect(response.status).toBe(401);
    expect(mocks.voiceCallFindFirst).not.toHaveBeenCalled();
  });

  describe("partial-failure retry (postCallProcessedAt still null, but earlier steps already succeeded)", () => {
    it("usage already recorded for this call: does not double-record on retry", async () => {
      mocks.usageRecordFindFirst.mockResolvedValue({ id: "usage-record-1" });
      const response = await POST(jobRequest());
      expect(response.status).toBe(200);

      expect(mocks.recordUsage).not.toHaveBeenCalled();
      // Everything after the usage step still runs — this call never fully completed.
      expect(mocks.contactCreate).toHaveBeenCalledTimes(1);
      expect(mocks.activityCreate).toHaveBeenCalledTimes(1);
      const calls = mocks.voiceCallUpdate.mock.calls as UpdateCall[];
      const markerCall = calls.find(([args]) => "postCallProcessedAt" in args.data);
      expect(markerCall).toBeDefined();
    });

    it("summary already generated for this call: does not create a duplicate activity on retry", async () => {
      mocks.voiceCallFindFirst.mockResolvedValue({
        ...freshCallRow(),
        contactId: "contact-existing-1",
        summary: "Caller asked about the strawberry toy.",
        sentiment: "positive",
      });
      mocks.usageRecordFindFirst.mockResolvedValue({ id: "usage-record-1" });
      // The prior attempt created the call's activity too.
      mocks.activityFindFirst.mockResolvedValue({ id: "activity-1" });

      const response = await POST(jobRequest());
      expect(response.status).toBe(200);

      expect(mocks.recordUsage).not.toHaveBeenCalled();
      expect(mocks.anthropicCreate).not.toHaveBeenCalled();
      expect(mocks.activityCreate).not.toHaveBeenCalled();
      // The call still gets marked processed once this (final, previously
      // incomplete) attempt reaches the end.
      const calls = mocks.voiceCallUpdate.mock.calls as UpdateCall[];
      const markerCall = calls.find(([args]) => "postCallProcessedAt" in args.data);
      expect(markerCall).toBeDefined();
    });

    it("notification already sent for this call: does not create a duplicate on retry", async () => {
      // Simulates a retry whose prior attempt got past the notification
      // step (step 4) but failed before postCallProcessedAt was set — e.g.
      // emitWorkflowEvent's enqueue call failing, or the marker write itself
      // failing.
      mocks.voiceCallFindFirst.mockResolvedValue({
        ...freshCallRow(),
        contactId: "contact-existing-1",
        summary: "Caller asked about the strawberry toy.",
        sentiment: "positive",
      });
      mocks.usageRecordFindFirst.mockResolvedValue({ id: "usage-record-1" });
      mocks.notificationFindFirst.mockResolvedValue({ id: "notif-already-sent-1" });

      const response = await POST(jobRequest());
      expect(response.status).toBe(200);

      expect(mocks.notificationCreate).not.toHaveBeenCalled();
      // The workflow trigger and completion marker still fire — this call
      // never fully completed.
      expect(mocks.emitWorkflowEvent).toHaveBeenCalledTimes(1);
      const calls = mocks.voiceCallUpdate.mock.calls as UpdateCall[];
      const markerCall = calls.find(([args]) => "postCallProcessedAt" in args.data);
      expect(markerCall).toBeDefined();
    });
  });
});

/**
 * The summary is best-effort -- a call record stands without it -- but a failure must
 * be visible in the logs (ids only, never the transcript), and a database failure while
 * saving the summary or its CRM activity must not be marked done: postCallProcessedAt
 * would stop every later attempt, losing that activity for good.
 */
describe("post-call job — summary failures are reported, not hidden", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  const logged = () =>
    errorSpy.mock.calls.flat().map((a) => (typeof a === "string" ? a : JSON.stringify(a)));
  const marked = () =>
    (mocks.voiceCallUpdate.mock.calls as UpdateCall[]).some(
      ([args]) => "postCallProcessedAt" in args.data,
    );

  it("a provider failure is logged with ids only and the call is still completed without a summary", async () => {
    mocks.anthropicCreate.mockRejectedValueOnce(new Error("upstream 529 overloaded"));

    const response = await POST(jobRequest());

    expect(response.status).toBe(200);
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      event: "post_call_summary_failed",
      orgId: ORG_ID,
      callId: "call-row-1",
      reason: "provider_error",
    });
    expect(lines.join(" ")).not.toContain("strawberry");
    expect(mocks.activityCreate).not.toHaveBeenCalled();
    expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);
    expect(marked()).toBe(true);
  });

  it("a reply that is not the expected JSON is logged as invalid_response", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Sure! Here is a summary of the call." }],
    });

    const response = await POST(jobRequest());

    expect(response.status).toBe(200);
    expect(JSON.parse(logged()[0]!)).toMatchObject({
      event: "post_call_summary_failed",
      reason: "invalid_response",
    });
    expect(marked()).toBe(true);
  });

  it("a database failure creating the activity fails the job so QStash retries it", async () => {
    mocks.activityCreate.mockRejectedValueOnce(new Error("connection terminated"));

    await expect(POST(jobRequest())).rejects.toThrow("connection terminated");

    expect(marked()).toBe(false);
  });

  it("the retry after that creates the missing activity once, from the saved summary, without a second paid summary", async () => {
    mocks.voiceCallFindFirst.mockResolvedValue({
      ...freshCallRow(),
      contactId: "contact-existing-1",
      summary: "Caller asked about the strawberry toy.",
      sentiment: "positive",
      actionsTaken: ["Send catalog link"],
    });
    mocks.usageRecordFindFirst.mockResolvedValue({ id: "usage-record-1" });

    const response = await POST(jobRequest());

    expect(response.status).toBe(200);
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.activityCreate).toHaveBeenCalledTimes(1);
    expect(mocks.activityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG_ID,
        contactId: "contact-existing-1",
        type: "VOICE_AI_CALL",
        body: "Caller asked about the strawberry toy.",
        metadata: { voiceCallId: "call-row-1", followUps: ["Send catalog link"] },
      }),
    });
    expect(marked()).toBe(true);
  });
});

/**
 * QStash's dedupe id does not make the job run exactly once: a duplicate end-of-call
 * report outside its window, or a retry overlapping a slow first attempt, runs it twice
 * at the same time. Each "already recorded?" check must then be serialized with its
 * insert, or both runs pass it. This models the database's interleaving and advisory
 * locks with mocks; it is not a real-Postgres test.
 */
describe("post-call job — two simultaneous runs for the same call", () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("record the minutes, the contact, the CRM activity and the owner notification once", async () => {
    const usage: unknown[] = [];
    const contacts: { id: string }[] = [];
    const activities: unknown[] = [];
    const notifications: unknown[] = [];
    // Run A pauses inside its usage check until run B reaches the same step: B either
    // waits for A's lock (with the lock) or runs the same check (without it).
    let aArrived = () => {};
    let bArrived = () => {};
    const aAtUsageCheck = new Promise<void>((resolve) => (aArrived = resolve));
    const bAtUsageStep = new Promise<void>((resolve) => (bArrived = resolve));
    locks.onContention = () => bArrived();
    let usageChecks = 0;
    mocks.usageRecordFindFirst.mockImplementation(async () => {
      usageChecks += 1;
      if (usageChecks === 1) {
        aArrived();
        await bAtUsageStep;
      } else {
        bArrived();
      }
      return usage.length ? { id: "usage-1" } : null;
    });
    mocks.recordUsage.mockImplementation(async () => {
      await tick();
      usage.push({});
    });
    mocks.contactMatches.mockImplementation(async () => {
      await tick();
      return contacts.slice(0, 2);
    });
    mocks.contactCreate.mockImplementation(async () => {
      await tick();
      const row = { id: `contact-${contacts.length + 1}` };
      contacts.push(row);
      return row;
    });
    mocks.activityFindFirst.mockImplementation(async () => {
      await tick();
      return activities.length ? { id: "activity-1" } : null;
    });
    mocks.activityCreate.mockImplementation(async () => {
      await tick();
      activities.push({});
      return { id: "activity-1" };
    });
    mocks.notificationFindFirst.mockImplementation(async () => {
      await tick();
      return notifications.length ? { id: "notif-1" } : null;
    });
    mocks.notificationCreate.mockImplementation(async () => {
      await tick();
      notifications.push({});
      return { id: "notif-1" };
    });

    const runA = POST(jobRequest());
    await aAtUsageCheck;
    const responses = await Promise.all([runA, POST(jobRequest())]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(usage).toHaveLength(1);
    expect(contacts).toHaveLength(1);
    expect(activities).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(locks.statements.length).toBeGreaterThan(0);
    expect(locks.statements.every((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
  });
});
