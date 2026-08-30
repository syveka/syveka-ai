import { beforeEach, describe, expect, it, vi } from "vitest";

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

const mocks = vi.hoisted(() => ({
  verifyJobRequest: vi.fn(async (req: Request): Promise<string | null> => await req.text()),
  voiceCallFindFirst: vi.fn(async (): Promise<unknown> => null),
  voiceCallUpdate: vi.fn(async (..._args: unknown[]) => ({})),
  usageRecordFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  contactFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  contactCreate: vi.fn(async () => ({ id: "contact-new-1" })),
  activityCreate: vi.fn(async () => ({ id: "activity-1" })),
  organizationMemberFindFirst: vi.fn(async () => ({ userId: "owner-1" })),
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
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    voiceCall: { findFirst: mocks.voiceCallFindFirst, update: mocks.voiceCallUpdate },
    usageRecord: { findFirst: mocks.usageRecordFindFirst },
    contact: { findFirst: mocks.contactFindFirst, create: mocks.contactCreate },
    activity: { create: mocks.activityCreate },
    organizationMember: { findFirst: mocks.organizationMemberFindFirst },
    notification: { create: mocks.notificationCreate },
  },
}));
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
  mocks.verifyJobRequest.mockImplementation(async (req: Request) => await req.text());
  mocks.voiceCallFindFirst.mockResolvedValue(freshCallRow());
  mocks.usageRecordFindFirst.mockResolvedValue(null);
  mocks.contactFindFirst.mockResolvedValue(null);
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
    expect(mocks.emitWorkflowEvent).toHaveBeenCalledTimes(1);

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
    mocks.contactFindFirst.mockResolvedValue({ id: "contact-existing-2" });
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
  });
});
