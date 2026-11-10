import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as VerifyModule from "@/server/jobs/verify";

/**
 * A job request whose signature fails must stop before any database access,
 * purge, email or provider call. The database is a recording fake, so any read
 * or write counts. A validly signed request reaches the same fakes in each
 * route, proving the assertions can fail. The second block runs the real
 * verifier against a fake QStash Receiver.
 */
const s = vi.hoisted(() => {
  const dbCalls: string[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, operation) => async () => {
          dbCalls.push(`${name}.${String(operation)}`);
          return operation === "findMany" ? [] : { count: 0 };
        },
      },
    );
  const db = new Proxy(
    {},
    {
      get: (_target, key) =>
        String(key).startsWith("$")
          ? async () => {
              dbCalls.push(String(key));
            }
          : model(String(key)),
    },
  );
  return {
    db,
    dbCalls,
    verifyJobRequest: vi.fn(),
    receiverVerify: vi.fn(),
    effects: {
      sendEmail: vi.fn(),
      embed: vi.fn(),
      extractText: vi.fn(),
      extractFromUrl: vi.fn(),
      chunkText: vi.fn(),
      createSupabaseAdmin: vi.fn(),
      anthropicCreate: vi.fn(),
      enqueue: vi.fn(),
      recordUsage: vi.fn(),
      getEntitlements: vi.fn(),
      getMonthUsage: vi.fn(),
      publishCreatorPost: vi.fn(),
      isOrganizationActive: vi.fn(),
    },
  };
});

vi.mock("@upstash/qstash", () => ({
  Receiver: class Receiver {
    verify(args: unknown) {
      return s.receiverVerify(args);
    }
  },
}));
vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: s.verifyJobRequest }));
vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: s.db, tenantDb: vi.fn() }));
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: s.effects.isOrganizationActive,
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: s.effects.sendEmail }));
vi.mock("../../emails/booking-email", () => ({
  bookingEmailSubject: () => "Reminder",
  BookingEmail: () => null,
}));
vi.mock("@/server/integrations/openai", () => ({ embed: s.effects.embed }));
vi.mock("@/server/ai/extract", () => ({
  extractText: s.effects.extractText,
  extractFromUrl: s.effects.extractFromUrl,
}));
vi.mock("@/server/ai/chunking", () => ({ chunkText: s.effects.chunkText }));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: s.effects.createSupabaseAdmin,
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  recordUsage: s.effects.recordUsage,
  getEntitlements: s.effects.getEntitlements,
  getMonthUsage: s.effects.getMonthUsage,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: s.effects.enqueue }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: s.effects.anthropicCreate } },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: () => ({ model: "synthetic-model", maxTokens: 100 }),
}));
vi.mock("@/server/services/ai-spend", () => ({
  assertAiQuotaAvailable: vi.fn(),
  AiSpendError: class AiSpendError extends Error {},
}));
vi.mock("@/server/services/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => false),
  isRestrictionSet: vi.fn(async () => false),
}));
vi.mock("@/server/services/creator-publishing", () => ({
  publishCreatorPost: s.effects.publishCreatorPost,
  PublishGuardError: class PublishGuardError extends Error {},
}));

// Loaded up front: a first-time concurrent dynamic import of a mocked module
// can resolve the real one in Vitest (see jobs-organization-guard.test.ts).
import "@/server/jobs/verify";
import "@/server/db/tenant";
import "@/server/jobs/organization-guard";
import "@/server/integrations/resend";
import "@/server/integrations/openai";
import "@/server/ai/extract";
import "@/server/ai/chunking";
import "@/server/supabase/server";
import "@/server/services/billing/entitlements";
import "@/server/jobs/queue";
import "@/server/integrations/anthropic";
import "@/server/ai/router";
import "@/server/services/ai-spend";
import "@/server/services/feature-flags";
import "@/server/services/creator-publishing";
import { POST as sendReminder } from "@/app/api/v1/jobs/send-reminder/route";
import { POST as embedDocument } from "@/app/api/v1/jobs/embed-document/route";
import { POST as runWorkflow } from "@/app/api/v1/jobs/run-workflow/route";
import { POST as usageRollup } from "@/app/api/v1/jobs/usage-rollup/route";
import { POST as publishCreatorPost } from "@/app/api/v1/jobs/publish-creator-post/route";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

const job = (body: string) =>
  new Request("https://jobs.test/api/v1/jobs/synthetic", {
    method: "POST",
    headers: { "upstash-signature": "synthetic-signature" },
    body,
  });

const routes = [
  {
    name: "send-reminder",
    POST: sendReminder,
    body: JSON.stringify({ reminderId: ID_A }),
    reached: () => expect(s.dbCalls).toContain("reminder.findUnique"),
  },
  {
    name: "embed-document",
    POST: embedDocument,
    body: JSON.stringify({ documentId: ID_A, orgId: ID_B }),
    reached: () => expect(s.dbCalls).toContain("document.findFirst"),
  },
  {
    name: "run-workflow",
    POST: runWorkflow,
    body: JSON.stringify({
      workflowId: ID_A,
      orgId: ID_B,
      triggerType: "synthetic.event",
      triggerData: {},
      sourceEventKey: "synthetic-event-1",
    }),
    reached: () => expect(s.dbCalls).toContain("workflow.findFirst"),
  },
  {
    name: "usage-rollup",
    POST: usageRollup,
    body: "",
    reached: () => expect(s.dbCalls).toContain("contact.deleteMany"),
  },
  {
    name: "publish-creator-post",
    POST: publishCreatorPost,
    body: JSON.stringify({ orgId: ID_A, postId: ID_B }),
    reached: () => expect(s.effects.publishCreatorPost).toHaveBeenCalledTimes(1),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  s.dbCalls.length = 0;
  s.effects.isOrganizationActive.mockResolvedValue(true);
  s.effects.publishCreatorPost.mockResolvedValue("published");
});

describe.each(routes)("$name job signature", ({ POST, body, reached }) => {
  it("answers 401 to an invalid signature, with no database, purge, email or provider call", async () => {
    s.verifyJobRequest.mockResolvedValue(null);

    const response = await POST(job(body));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid signature" });
    expect(s.verifyJobRequest).toHaveBeenCalledTimes(1);
    expect(s.dbCalls).toEqual([]);
    for (const effect of Object.values(s.effects)) expect(effect).not.toHaveBeenCalled();
  });

  it("proceeds past the signature check for a valid signature", async () => {
    s.verifyJobRequest.mockImplementation(async (request: Request) => request.text());

    const response = await POST(job(body));

    expect(response.status).not.toBe(401);
    reached();
  });
});

describe("verifyJobRequest (real)", () => {
  const realVerify = async () =>
    (await vi.importActual<typeof VerifyModule>("@/server/jobs/verify")).verifyJobRequest;

  it("returns null for a missing header without reading the body or calling the Receiver", async () => {
    const verifyJobRequest = await realVerify();
    const request = new Request("https://jobs.test/x", { method: "POST", body: "{}" });

    await expect(verifyJobRequest(request)).resolves.toBeNull();

    expect(s.receiverVerify).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  it("returns null when the Receiver rejects the signature", async () => {
    const verifyJobRequest = await realVerify();
    s.receiverVerify.mockRejectedValueOnce(new Error("signature mismatch"));

    await expect(verifyJobRequest(job('{"a":1}'))).resolves.toBeNull();
    expect(s.receiverVerify).toHaveBeenCalledTimes(1);
  });

  it("returns null when the Receiver answers false", async () => {
    const verifyJobRequest = await realVerify();
    s.receiverVerify.mockResolvedValueOnce(false);

    await expect(verifyJobRequest(job('{"a":1}'))).resolves.toBeNull();
  });

  it("verifies the signature, raw body and url, then returns the body", async () => {
    const verifyJobRequest = await realVerify();
    s.receiverVerify.mockResolvedValueOnce(true);

    await expect(verifyJobRequest(job('{"a":1}'))).resolves.toBe('{"a":1}');

    expect(s.receiverVerify).toHaveBeenCalledWith({
      signature: "synthetic-signature",
      body: '{"a":1}',
      url: "https://jobs.test/api/v1/jobs/synthetic",
    });
  });
});
