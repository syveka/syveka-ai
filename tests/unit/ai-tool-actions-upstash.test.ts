import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";

/**
 * Regression for the staging failure of #221: every confirmation returned
 * 422 ("couldn't be completed"). Staging uses the real @upstash/redis REST
 * client, which by default JSON-deserializes string elements of a script's
 * array result, so the stored input arrived as an object, not a string.
 *
 * Here the REAL Upstash client is used with only its HTTP transport stubbed:
 * the stub speaks the Upstash REST protocol (base64-encoded strings) in
 * front of an in-memory store with the scripts' semantics, so the client's
 * own decoding and deserialization run exactly as in staging.
 */
const m = vi.hoisted(() => ({
  contactCreate: vi.fn(),
  audit: vi.fn(async () => undefined),
  store: new Map<string, Record<string, string>>(),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    contact: {
      create: m.contactCreate,
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
    },
    businessDnaService: { findFirst: vi.fn(async () => null) },
    availabilitySchedule: { findFirst: vi.fn(async () => null) },
  })),
  unscopedPrisma: {},
}));
vi.mock("@/server/services/audit", () => ({ audit: m.audit }));
// The plan check is covered in ai-tools-create-contact.test.ts; here only the
// action store's transport is under test (the organization is within its plan).
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(async () => ({})),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn(async () => []) }));

import {
  ACTION_STATUS_SCRIPT,
  DECIDE_ACTION_SCRIPT,
  PROPOSE_ACTION_SCRIPT,
  decideToolAction,
  liveActionStatus,
  proposeToolAction,
} from "@/server/ai/tool-actions";
import type { ToolIdentity } from "@/server/ai/tools";

type Reply = number | string | Reply[];

/** The scripts' semantics, as Redis would return them (strings stay strings). */
function runScript(script: string, key: string, args: string[]): Reply {
  if (script === PROPOSE_ACTION_SCRIPT) {
    if (m.store.has(key)) return 0;
    const [org, user, conversation, tool, input, digest, expiresAt] = args;
    m.store.set(key, {
      org: org!,
      user: user!,
      conversation: conversation!,
      tool: tool!,
      input: input!,
      digest: digest!,
      expiresAt: expiresAt!,
      status: "pending",
    });
    return 1;
  }
  if (script === ACTION_STATUS_SCRIPT) {
    const [org, user, conversation] = args;
    const a = m.store.get(key);
    if (!a || a.org !== org || a.user !== user || a.conversation !== conversation) return "";
    return a.status!;
  }
  if (script === DECIDE_ACTION_SCRIPT) {
    const [org, user, conversation, digest, decision, now] = args;
    const a = m.store.get(key);
    if (!a || a.org !== org || a.user !== user || a.conversation !== conversation) return [-1];
    if (Number(a.expiresAt) <= Number(now)) return [-1];
    if (a.status !== "pending") return [-3];
    if (a.digest !== digest) return [-4];
    a.status = decision!;
    return [1, a.tool!, a.input!];
  }
  throw new Error("unexpected script");
}

/** Upstash REST encoding: strings base64 when the client asks for it. */
const encode = (v: Reply, base64: boolean): unknown =>
  Array.isArray(v)
    ? v.map((x) => encode(x, base64))
    : typeof v === "string" && base64
      ? Buffer.from(v, "utf8").toString("base64")
      : v;

const fetchStub = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as unknown[];
  const base64 = new Headers(init?.headers).get("Upstash-Encoding") === "base64";
  const run = (command: string[]) => {
    expect(command[0]).toBe("eval");
    const [, script, , key, ...args] = command;
    return { result: encode(runScript(script!, key!, args.map(String)), base64) };
  };
  // Single command, or a (auto-)pipeline of commands.
  const payload = Array.isArray(body[0]) ? (body as string[][]).map(run) : run(body as string[]);
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
});

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const me: ToolIdentity = { orgId: ORG, userId: USER, role: "MEMBER", actorType: "user" };

let redis: Redis;
beforeEach(() => {
  vi.clearAllMocks();
  m.store.clear();
  m.contactCreate.mockResolvedValue({ id: "contact-1" });
  vi.stubGlobal("fetch", fetchStub);
  vi.spyOn(console, "info").mockImplementation(() => {});
  // The same construction as src/server/integrations/redis.ts (default options).
  redis = new Redis({ url: "https://upstash.example", token: "test-token" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pending actions through the real Upstash client (staging transport)", () => {
  it("the client really does deserialize the stored input to an object (the staging condition)", async () => {
    const raw = await redis.eval(
      PROPOSE_ACTION_SCRIPT,
      ["k"],
      [ORG, USER, CONV, "createContact", '{"firstName":"QA"}', "d", "9999999999999", "600"],
    );
    expect(raw).toBe(1);
    const decided = (await redis.eval(
      DECIDE_ACTION_SCRIPT,
      ["k"],
      [ORG, USER, CONV, "d", "confirmed", "1"],
    )) as unknown[];
    expect(decided[1]).toBe("createContact");
    expect(decided[2]).toEqual({ firstName: "QA" }); // an object, not the stored string
  });

  it("Confirm creates exactly one contact; a replay is refused (the staging test case)", async () => {
    const { action } = await proposeToolAction(redis, me, CONV, "createContact", {
      firstName: "QA Disposable Test",
    });
    expect(action).not.toBeNull();
    expect(m.contactCreate).not.toHaveBeenCalled();

    const request = {
      id: action!.id,
      conversationId: CONV,
      digest: action!.digest,
      decision: "confirm" as const,
    };
    expect(await decideToolAction(redis, me, request)).toEqual({
      ok: true,
      tool: "createContact",
      status: "done",
      result: { id: "contact-1", created: true },
    });
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
    expect(m.contactCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: ORG, firstName: "QA Disposable Test" }),
      }),
    );
    expect(await decideToolAction(redis, me, request)).toEqual({
      ok: false,
      reason: "already_decided",
    });
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
  });

  it("Cancel works and nothing is created", async () => {
    const { action } = await proposeToolAction(redis, me, CONV, "createContact", {
      firstName: "QA",
    });
    expect(
      await decideToolAction(redis, me, {
        id: action!.id,
        conversationId: CONV,
        digest: action!.digest,
        decision: "cancel",
      }),
    ).toEqual({ ok: true, tool: "createContact", status: "canceled" });
    expect(m.contactCreate).not.toHaveBeenCalled();
  });

  it("a stored input that isn't an object is still refused (fails closed)", async () => {
    m.store.set("ai:action:bad", {
      org: ORG,
      user: USER,
      conversation: CONV,
      tool: "createContact",
      input: "[1,2]",
      digest: "d",
      expiresAt: "9999999999999",
      status: "pending",
    });
    expect(
      await decideToolAction(redis, me, {
        id: "bad",
        conversationId: CONV,
        digest: "d",
        decision: "confirm",
      }),
    ).toEqual({ ok: false, reason: "invalid_action" });
    expect(m.contactCreate).not.toHaveBeenCalled();
  });

  it("the live status reads correctly through the Upstash client (strings survive deserialization)", async () => {
    const { action } = await proposeToolAction(redis, me, CONV, "createContact", {
      firstName: "QA",
    });
    expect(await liveActionStatus(redis, me, CONV, action!.id)).toBe("pending");
    await decideToolAction(redis, me, {
      id: action!.id,
      conversationId: CONV,
      digest: action!.digest,
      decision: "cancel",
    });
    expect(await liveActionStatus(redis, me, CONV, action!.id)).toBe("decided");
    expect(await liveActionStatus(redis, me, CONV, crypto.randomUUID())).toBe("missing");
    expect(await liveActionStatus(redis, { ...me, orgId: "other" }, CONV, action!.id)).toBe(
      "missing",
    );
  });
});
