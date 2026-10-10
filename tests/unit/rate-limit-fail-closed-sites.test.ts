import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Paid AI endpoints refuse (fail closed) when their rate limit can't be
 * verified. The real limit helpers (src/server/integrations/redis.ts) run
 * against a mocked Upstash Ratelimit that either times out (Upstash then
 * resolves `success: true, reason: "timeout"`), throws (a Redis fetch error)
 * or denies. Every provider / paid-work entry point is mocked and must not be
 * reached when the limit is unverifiable.
 */
const m = vi.hoisted(() => ({
  mode: "ok" as "ok" | "timeout" | "throw" | "denied",
  ctx: {
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "OWNER",
    locale: "EN",
  },
  streamClaude: vi.fn(),
  moderation: vi.fn(async () => false),
  decideToolAction: vi.fn(),
  getMonthUsage: vi.fn(async () => 0),
  transcribeAudio: vi.fn(),
  extractBusinessDnaFromUrl: vi.fn(),
  workflowRunCreate: vi.fn(),
  enqueue: vi.fn(),
  startVoiceSession: vi.fn(),
}));

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow() {
      return {};
    }
    async limit() {
      const reset = Date.now() + 60_000;
      if (m.mode === "throw") throw new Error("fetch failed");
      if (m.mode === "timeout") {
        return { success: true, reason: "timeout", limit: 0, remaining: 0, reset: 0 };
      }
      if (m.mode === "denied") return { success: false, limit: 5, remaining: 0, reset };
      return { success: true, limit: 5, remaining: 4, reset };
    }
  }
  return { Ratelimit };
});
vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isChatTranscriptionEnabled: () => true,
}));

vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => m.ctx),
  AuthError: class AuthError extends Error {
    status = 403;
  },
}));
vi.mock("@/server/auth/guard", () => ({ requirePermission: vi.fn(async () => m.ctx) }));
vi.mock("@/server/auth/permissions", () => ({ can: vi.fn(() => true) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

// Chat route
vi.mock("@/server/integrations/openai", () => ({
  isFlaggedByModeration: m.moderation,
  transcribeAudio: m.transcribeAudio,
  TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
}));
vi.mock("@/server/integrations/anthropic", () => ({ streamClaude: m.streamClaude }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({ conversation: { findFirst: vi.fn(), create: vi.fn() } })),
  unscopedPrisma: {
    workflow: { findFirstOrThrow: vi.fn(async () => ({ id: "wf-1" })) },
    workflowRun: { create: m.workflowRunCreate },
  },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: vi.fn() }));
vi.mock("@/server/ai/prompts/system", () => ({ buildSystemPrompt: vi.fn() }));
vi.mock("@/server/business-dna/context", () => ({ getBusinessDnaContext: vi.fn() }));
vi.mock("@/server/ai/rag", () => ({
  retrieveChunks: vi.fn(),
  extractValidCitations: vi.fn(),
}));
vi.mock("@/server/ai/tools", () => ({
  anthropicToolsFor: vi.fn(),
  executeTool: vi.fn(),
  READ_ONLY_TOOL_NAMES: [],
  WRITE_TOOL_NAMES: [],
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(async () => undefined),
  getMonthUsage: m.getMonthUsage,
  recordUsage: vi.fn(),
  getEntitlements: vi.fn(async () => ({ readOnly: false, activeWorkflows: 5 })),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/conversations", () => ({
  attachDocumentsToConversation: vi.fn(),
  ensureConversationSummary: vi.fn(),
  generateTitle: vi.fn(),
  getConversationDocumentIds: vi.fn(),
}));
vi.mock("@/server/ai/voice-conversation", () => ({
  isVoiceConversationMember: () => true,
  readVoiceConversationConfig: () => ({ maxTurnSeconds: 30, sessionSeconds: 600 }),
  startVoiceSession: m.startVoiceSession,
  tryReadVoiceAllowance: vi.fn(async () => null),
  isVoiceConversationFeatureOn: () => false,
}));
// AI action decisions
vi.mock("@/server/ai/tool-actions", () => ({ decideToolAction: m.decideToolAction }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));
// Transcription
vi.mock("@/server/ai/transcription-pilot", () => ({
  isTranscriptionPilotMember: () => true,
  reserveDailyTranscriptionAttempt: vi.fn(),
}));
// Business DNA extraction
vi.mock("@/server/services/business-dna-extraction", () => ({
  extractBusinessDnaFromUrl: m.extractBusinessDnaFromUrl,
  BusinessDnaExtractionError: class extends Error {},
  UrlIngestionError: class extends Error {},
}));
// Workflow test runs
vi.mock("@/server/services/workflows", () => ({
  upsertWorkflow: vi.fn(),
  setWorkflowActive: vi.fn(),
  WorkflowError: class extends Error {},
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: m.enqueue }));

import { POST as chatPost } from "@/app/api/v1/ai/chat/route";
import { POST as actionPost } from "@/app/api/v1/ai/actions/[id]/route";
import { POST as transcribePost } from "@/app/api/v1/ai/transcribe/route";
import { POST as extractPost } from "@/app/api/v1/business-dna/extract/route";
import { POST as voiceSessionPost } from "@/app/api/v1/ai/voice-conversation/session/route";
import { assertAiSpendAllowed } from "@/server/services/ai-spend";
import { testWorkflowAction } from "@/actions/workflows";
import type { TenantContext } from "@/server/auth/session";

const SAME_ORIGIN = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
const ACTION_ID = "44444444-4444-4444-8444-444444444444";

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: SAME_ORIGIN,
    body: JSON.stringify(body),
  });

const transcribeRequest = () => {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(4096)], { type: "audio/webm" }), "recording");
  return new Request("http://localhost/api/v1/ai/transcribe", {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
    body: form,
  });
};

const providerCalls = () =>
  m.streamClaude.mock.calls.length +
  m.moderation.mock.calls.length +
  m.decideToolAction.mock.calls.length +
  m.getMonthUsage.mock.calls.length +
  m.transcribeAudio.mock.calls.length +
  m.extractBusinessDnaFromUrl.mock.calls.length +
  m.workflowRunCreate.mock.calls.length +
  m.enqueue.mock.calls.length +
  m.startVoiceSession.mock.calls.length;

/** Each site, reduced to { status, code } so the refusals can be compared. */
const sites: Record<string, () => Promise<{ status: number; code: unknown }>> = {
  "POST /api/v1/ai/chat": async () => {
    const res = await chatPost(post("/api/v1/ai/chat", { message: "hello" }));
    return { status: res.status, code: (await res.json()).error?.code };
  },
  "POST /api/v1/ai/actions/[id]": async () => {
    const res = await actionPost(
      post(`/api/v1/ai/actions/${ACTION_ID}`, {
        decision: "confirm",
        conversationId: "33333333-3333-4333-8333-333333333333",
        digest: "a".repeat(64),
      }),
      { params: Promise.resolve({ id: ACTION_ID }) },
    );
    return { status: res.status, code: (await res.json()).error?.code };
  },
  "assertAiSpendAllowed (deal insights, scheduling, meeting summary, email drafts)": async () => {
    try {
      await assertAiSpendAllowed(m.ctx as unknown as TenantContext);
      return { status: 200, code: undefined };
    } catch (e) {
      return { status: 0, code: (e as { code?: unknown }).code };
    }
  },
  "POST /api/v1/ai/transcribe": async () => {
    const res = await transcribePost(transcribeRequest());
    return { status: res.status, code: (await res.json()).error?.code };
  },
  "POST /api/v1/business-dna/extract": async () => {
    const res = await extractPost(
      post("/api/v1/business-dna/extract", { url: "https://example.com" }),
    );
    return { status: res.status, code: (await res.json()).error?.code };
  },
  testWorkflowAction: async () => {
    const result = await testWorkflowAction("wf-1");
    return { status: 0, code: result.error };
  },
  "POST /api/v1/ai/voice-conversation/session": async () => {
    const res = await voiceSessionPost(post("/api/v1/ai/voice-conversation/session", {}));
    return { status: res.status, code: (await res.json()).error?.code };
  },
};

/** The refusal each site gives when its limit can't be verified. */
const UNAVAILABLE: Record<string, { status: number; code: string }> = {
  "POST /api/v1/ai/chat": { status: 503, code: "service_unavailable" },
  "POST /api/v1/ai/actions/[id]": { status: 503, code: "service_unavailable" },
  "assertAiSpendAllowed (deal insights, scheduling, meeting summary, email drafts)": {
    status: 0,
    code: "unavailable",
  },
  // Existing endpoint-specific codes, already mapped by the voice UI.
  "POST /api/v1/ai/transcribe": { status: 503, code: "transcription_unavailable" },
  "POST /api/v1/business-dna/extract": { status: 503, code: "service_unavailable" },
  testWorkflowAction: { status: 0, code: "service_unavailable" },
  "POST /api/v1/ai/voice-conversation/session": {
    status: 503,
    code: "voice_conversation_unavailable",
  },
};

/** The existing refusal each site gives when its limit is reached. */
const LIMITED: Record<string, { status: number; code: string }> = {
  "POST /api/v1/ai/chat": { status: 429, code: "rate_limited" },
  "POST /api/v1/ai/actions/[id]": { status: 429, code: "rate_limited" },
  "assertAiSpendAllowed (deal insights, scheduling, meeting summary, email drafts)": {
    status: 0,
    code: "rate_limited",
  },
  "POST /api/v1/ai/transcribe": { status: 429, code: "rate_limited" },
  "POST /api/v1/business-dna/extract": { status: 429, code: "rate_limited" },
  testWorkflowAction: { status: 0, code: "rate_limited" },
  "POST /api/v1/ai/voice-conversation/session": { status: 429, code: "rate_limited" },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.mode = "ok";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(Object.keys(sites))("%s", (site) => {
  it.each(["timeout", "throw"] as const)(
    "refuses as unavailable, before any paid work, when the limiter %s",
    async (mode) => {
      m.mode = mode;
      expect(await sites[site]!()).toEqual(UNAVAILABLE[site]);
      expect(providerCalls()).toBe(0);
    },
  );

  it("keeps its existing refusal when the limit is reached", async () => {
    m.mode = "denied";
    expect(await sites[site]!()).toEqual(LIMITED[site]);
    expect(providerCalls()).toBe(0);
  });
});

describe("rate-limited responses keep their headers", () => {
  it.each([
    ["chat", () => chatPost(post("/api/v1/ai/chat", { message: "hello" }))],
    [
      "business DNA extraction",
      () => extractPost(post("/api/v1/business-dna/extract", { url: "https://example.com" })),
    ],
  ] as const)("%s sends Retry-After on 429 and not on 503", async (_name, call) => {
    m.mode = "denied";
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);

    m.mode = "timeout";
    const unavailable = await call();
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("Retry-After")).toBeNull();
  });
});
