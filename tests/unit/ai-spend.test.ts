import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI features outside chat (deal insights, scheduling assistant, meeting summary, email
 * drafts) each make a paid provider call. They share chat's per-user/per-org rate limits and
 * the monthly AI message quota, and are refused before any provider call once over either.
 */
const m = vi.hoisted(() => {
  class EntitlementError extends Error {}
  return {
    EntitlementError,
    limitAiChat: vi.fn(async (_orgId: string, _userId: string) => ({ success: true })),
    getMonthUsage: vi.fn(async (_orgId: string, _metric: string) => 0),
    assertWithinLimit: vi.fn(async (_orgId: string, _check: unknown) => undefined),
    recordUsage: vi.fn(async (..._args: unknown[]) => undefined),
    requirePermission: vi.fn(async () => ({ orgId: "org-a", userId: "user-1" })),
    generateDealInsights: vi.fn(async () => undefined),
    assistScheduling: vi.fn(async () => ({
      reply: "ok",
      suggestedSlots: [],
      timezone: "UTC",
      aiUsed: true,
    })),
    generateMeetingSummary: vi.fn(async () => ({ summary: "s", followUps: [], aiUsed: true })),
    generateEmailDraft: vi.fn(async () => undefined),
  };
});

vi.mock("@/server/integrations/redis", () => ({ limitAiChat: m.limitAiChat }));
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: m.EntitlementError,
  getMonthUsage: m.getMonthUsage,
  assertWithinLimit: m.assertWithinLimit,
  recordUsage: m.recordUsage,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: m.requirePermission }));
vi.mock("@/server/services/deals", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateDealInsights: m.generateDealInsights,
}));
vi.mock("@/server/services/booking-assistant", () => ({
  assistScheduling: m.assistScheduling,
  generateMeetingSummary: m.generateMeetingSummary,
}));
vi.mock("@/server/services/inbox-ai", () => ({ generateEmailDraft: m.generateEmailDraft }));

import { generateDealInsightsAction } from "@/actions/deals";
import { meetingSummaryAction, schedulingAssistantAction } from "@/actions/calendar";
import { generateDraftAction } from "@/actions/inbox";

const form = (entries: Record<string, string> = {}) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.set(k, v);
  return data;
};

const providerCalls = () =>
  m.generateDealInsights.mock.calls.length +
  m.assistScheduling.mock.calls.length +
  m.generateMeetingSummary.mock.calls.length +
  m.generateEmailDraft.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AI features outside chat are rate-limited and quota-checked", () => {
  it("runs and counts one AI message per call within the limits", async () => {
    expect(await generateDealInsightsAction("deal-1", {}, form())).toEqual({
      message: "insightsGenerated",
    });
    await schedulingAssistantAction({}, form({ request: "next week" }));
    await meetingSummaryAction("event-1");
    expect(await generateDraftAction("thread-1", {}, form())).toEqual({ message: "drafted" });

    expect(m.limitAiChat).toHaveBeenCalledWith("org-a", "user-1");
    expect(providerCalls()).toBe(4);
    expect(m.recordUsage).toHaveBeenCalledTimes(4);
    for (const call of m.recordUsage.mock.calls)
      expect(call.slice(0, 3)).toEqual(["org-a", "AI_MESSAGES", 1]);
  });

  it("does not count a fallback answer that made no AI call", async () => {
    m.assistScheduling.mockResolvedValueOnce({
      reply: "fallback",
      suggestedSlots: [],
      timezone: "UTC",
      aiUsed: false,
    });
    await schedulingAssistantAction({}, form({ request: "next week" }));
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("refuses every feature before the provider call when rate-limited", async () => {
    m.limitAiChat.mockResolvedValue({ success: false });
    try {
      expect(await generateDealInsightsAction("deal-1", {}, form())).toEqual({
        error: "rate_limited",
      });
      expect(await schedulingAssistantAction({}, form({ request: "next week" }))).toEqual({
        error: "rate_limited",
      });
      await expect(meetingSummaryAction("event-1")).rejects.toMatchObject({ code: "rate_limited" });
      expect(await generateDraftAction("thread-1", {}, form())).toEqual({ error: "rate_limited" });
    } finally {
      m.limitAiChat.mockResolvedValue({ success: true });
    }
    expect(providerCalls()).toBe(0);
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("refuses every feature before the provider call when the limit can't be verified", async () => {
    m.limitAiChat.mockResolvedValue({ success: false, unavailable: true } as never);
    try {
      expect(await generateDealInsightsAction("deal-1", {}, form())).toEqual({
        error: "unavailable",
      });
      expect(await schedulingAssistantAction({}, form({ request: "next week" }))).toEqual({
        error: "unavailable",
      });
      await expect(meetingSummaryAction("event-1")).rejects.toMatchObject({ code: "unavailable" });
      expect(await generateDraftAction("thread-1", {}, form())).toEqual({ error: "unavailable" });
    } finally {
      m.limitAiChat.mockResolvedValue({ success: true });
    }
    expect(providerCalls()).toBe(0);
    expect(m.getMonthUsage).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("refuses every feature before the provider call once the monthly quota is used", async () => {
    m.assertWithinLimit.mockRejectedValue(new m.EntitlementError("quota"));
    try {
      expect(await generateDealInsightsAction("deal-1", {}, form())).toEqual({ error: "quota" });
      expect(await schedulingAssistantAction({}, form({ request: "next week" }))).toEqual({
        error: "quota",
      });
      await expect(meetingSummaryAction("event-1")).rejects.toMatchObject({ code: "quota" });
      expect(await generateDraftAction("thread-1", {}, form())).toEqual({ error: "quota" });
    } finally {
      m.assertWithinLimit.mockResolvedValue(undefined);
    }
    expect(providerCalls()).toBe(0);
  });
});
