import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ARABIC_SUMMARY = "سأل المتصل عن موعد يوم الخميس.";
const ARABIC_FOLLOW_UP = "تأكيد الموعد مع المتصل";

const mocks = vi.hoisted(() => ({
  voiceCallFindFirst: vi.fn(),
  voiceCallUpdate: vi.fn(async (..._args: unknown[]) => ({})),
  activityCreate: vi.fn(async (..._args: unknown[]) => ({ id: "activity-1" })),
  anthropicCreate: vi.fn(),
}));

vi.mock("@/server/jobs/verify", () => ({
  verifyJobRequest: vi.fn(async (req: Request) => await req.text()),
}));
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: vi.fn(async () => true),
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/db/tenant", () => {
  const client: Record<string, unknown> = {
    voiceCall: { findFirst: mocks.voiceCallFindFirst, update: mocks.voiceCallUpdate },
    usageRecord: { findFirst: vi.fn(async () => null) },
    contact: { findFirst: vi.fn(async () => ({ id: "contact-1" })), create: vi.fn() },
    activity: { create: mocks.activityCreate, findFirst: vi.fn(async () => null) },
    organizationMember: { findFirst: vi.fn(async () => ({ userId: "owner-1" })) },
    notification: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  };
  client.$transaction = async (step: (tx: unknown) => Promise<unknown>) => await step(client);
  return { unscopedPrisma: client };
});
// The provider is only ever this mock, so these tests make no paid calls.
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: mocks.anthropicCreate } },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: () => ({ model: "claude-haiku", maxTokens: 512 }),
}));
vi.mock("@/server/services/billing/entitlements", () => ({ recordUsage: vi.fn(async () => {}) }));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: vi.fn(async () => {}) }));

import { POST } from "@/app/api/v1/jobs/post-call/route";

const TRANSCRIPT = [{ role: "user", text: "هل يوجد موعد يوم الخميس؟" }];

function callRow(language: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "call-row-1",
    vapiCallId: "call-1",
    organizationId: ORG_ID,
    contactId: "contact-1",
    callerNumber: "+358401234567",
    status: "COMPLETED",
    durationSeconds: 90,
    transcript: TRANSCRIPT,
    summary: null,
    sentiment: null,
    actionsTaken: null,
    postCallProcessedAt: null,
    assistant: { name: "Assistant", language },
    ...overrides,
  };
}

function providerReplies(analysis: unknown) {
  mocks.anthropicCreate.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(analysis) }],
  });
}

async function runJob() {
  return POST(
    new Request("http://localhost/api/v1/jobs/post-call", {
      method: "POST",
      body: JSON.stringify({ vapiCallId: "call-1", orgId: ORG_ID }),
    }),
  );
}

/** The prompt actually handed to the provider. */
function promptSent(): string {
  expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
  const [request] = mocks.anthropicCreate.mock.calls[0] as [
    { messages: Array<{ role: string; content: string }> },
  ];
  return request.messages[0]!.content;
}

/** The exact prompt the job sent for FI and EN before Arabic was added. */
function originalPrompt(language: "Finnish" | "English"): string {
  return `Analyze this phone call transcript. Respond with ONLY valid JSON: {"summary": "<3-5 sentence summary in ${language}>", "sentiment": "positive"|"neutral"|"negative", "followUps": ["<action item>", ...max 5]}\n\nTranscript:\n${JSON.stringify(TRANSCRIPT)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  providerReplies({ summary: "A summary.", sentiment: "neutral", followUps: ["Call back"] });
});

describe("post-call summary language", () => {
  it("AR asks the provider for an Arabic summary and Arabic follow-ups", async () => {
    mocks.voiceCallFindFirst.mockResolvedValue(callRow("AR"));
    await runJob();
    const prompt = promptSent();
    expect(prompt).toContain("summary in Arabic");
    expect(prompt).toContain("<action item in Arabic>");
    expect(prompt).not.toContain("summary in English");
    expect(prompt).not.toContain("summary in Finnish");
  });

  it("AR keeps the JSON contract, including English keys and sentiment values", async () => {
    mocks.voiceCallFindFirst.mockResolvedValue(callRow("AR"));
    await runJob();
    const prompt = promptSent();
    expect(prompt).toContain('"sentiment": "positive"|"neutral"|"negative"');
    expect(prompt).toMatch(/"followUps": \[/);
    expect(prompt).toContain("Write the summary and follow-ups in Arabic");
    expect(prompt).toContain("Keep the JSON keys and the sentiment value exactly as shown");
    expect(prompt.endsWith(`Transcript:\n${JSON.stringify(TRANSCRIPT)}`)).toBe(true);
  });

  it("saves an Arabic reply unchanged, and uses it for the CRM activity", async () => {
    mocks.voiceCallFindFirst.mockResolvedValue(callRow("AR"));
    providerReplies({
      summary: ARABIC_SUMMARY,
      sentiment: "positive",
      followUps: [ARABIC_FOLLOW_UP],
    });
    const response = await runJob();
    expect(response.status).toBe(200);
    expect(mocks.voiceCallUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          summary: ARABIC_SUMMARY,
          sentiment: "positive",
          actionsTaken: [ARABIC_FOLLOW_UP],
        },
      }),
    );
    expect(JSON.stringify(mocks.activityCreate.mock.calls)).toContain(ARABIC_SUMMARY);
  });

  it("a translated sentiment still fails validation, so the enum is unchanged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.voiceCallFindFirst.mockResolvedValue(callRow("AR"));
    providerReplies({ summary: ARABIC_SUMMARY, sentiment: "إيجابي", followUps: [] });
    await runJob();
    const summaryWrites = mocks.voiceCallUpdate.mock.calls.filter(
      (call) => "summary" in ((call[0] as { data: object }).data ?? {}),
    );
    expect(summaryWrites).toEqual([]);
  });

  it.each([
    ["FI", "Finnish"],
    ["EN", "English"],
  ] as const)("%s sends exactly the prompt it always did", async (language, name) => {
    mocks.voiceCallFindFirst.mockResolvedValue(callRow(language));
    await runJob();
    expect(promptSent()).toBe(originalPrompt(name));
  });

  it.each([
    ["an unknown value", "SV"],
    ["lower case", "ar"],
    ["null", null],
    ["undefined", undefined],
  ])("%s falls back to the English prompt, as it always did", async (_label, language) => {
    mocks.voiceCallFindFirst.mockResolvedValue(callRow(language));
    await runJob();
    expect(promptSent()).toBe(originalPrompt("English"));
  });

  it("an existing summary isn't regenerated or changed, whatever its language", async () => {
    mocks.voiceCallFindFirst.mockResolvedValue(
      callRow("AR", {
        summary: "An older English summary.",
        sentiment: "neutral",
        actionsTaken: ["Call back"],
      }),
    );
    await runJob();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    const summaryWrites = mocks.voiceCallUpdate.mock.calls.filter(
      (call) => "summary" in ((call[0] as { data: object }).data ?? {}),
    );
    expect(summaryWrites).toEqual([]);
  });

  it("a provider failure on an Arabic call leaves it for the same failure path", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.voiceCallFindFirst.mockResolvedValue(callRow("AR"));
    mocks.anthropicCreate.mockRejectedValue(new Error("upstream 529"));
    const response = await runJob();
    expect(response.status).toBe(200);
    expect(JSON.stringify(consoleError.mock.calls)).toContain("provider_error");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("هل يوجد");
  });

  it("reads the call only within the job's organization", async () => {
    mocks.voiceCallFindFirst.mockResolvedValue(callRow("AR"));
    await runJob();
    expect(mocks.voiceCallFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vapiCallId: "call-1", organizationId: ORG_ID } }),
    );
  });
});
