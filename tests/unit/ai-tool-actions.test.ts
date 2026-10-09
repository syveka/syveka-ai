import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-enforced confirmation of AI write tools (typed chat): a write the
 * model calls is only stored; it runs once, exactly as stored, after the
 * signed-in user who received it confirms. Real: the tool registry (input
 * schemas, permissions, the tools themselves) and the action module/route.
 * Mocked: the database, audit, session and an isolated in-memory action
 * store that applies the scripts' rules (the Lua itself runs against a real
 * Redis in ai-tool-actions-redis.test.ts).
 */
const m = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    calendarEvent: { findFirst: vi.fn(), create: vi.fn() },
    contact: { findFirstOrThrow: vi.fn() },
  };
  return {
    tx,
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    contactCreate: vi.fn(),
    contactFindFirst: vi.fn(),
    activityCreate: vi.fn(),
    audit: vi.fn(async () => undefined),
    ctx: null as null | { orgId: string; userId: string; role: string },
    rate: { success: true } as { success: boolean },
    storeDown: false,
    store: new Map<string, Record<string, string>>(),
    now: 1_800_000_000_000,
  };
});

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    contact: {
      create: m.contactCreate,
      findFirst: m.contactFindFirst,
      findFirstOrThrow: vi.fn(async () => ({ id: "c" })),
      findMany: vi.fn(async () => []),
    },
    activity: { create: m.activityCreate },
    calendarEvent: { findMany: vi.fn(async () => []) },
    businessDnaService: { findFirst: vi.fn(async () => null) },
    availabilitySchedule: { findFirst: vi.fn(async () => null) },
  })),
  unscopedPrisma: { $transaction: m.transaction },
}));
vi.mock("@/server/services/audit", () => ({ audit: m.audit }));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn(async () => []) }));
vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => {
    if (!m.ctx) throw new Error("unauthenticated");
    return m.ctx;
  }),
}));

import {
  ACTION_TTL_SECONDS,
  DECIDE_ACTION_SCRIPT,
  PROPOSE_ACTION_SCRIPT,
  actionDigest,
  decideToolAction,
  proposeToolAction,
  type EvalClient,
  type ProposedAction,
} from "@/server/ai/tool-actions";
import {
  READ_ONLY_TOOL_NAMES,
  TOOL_REGISTRY,
  WRITE_TOOL_NAMES,
  executeTool,
  toolRequiresConfirmation,
  type ToolIdentity,
} from "@/server/ai/tools";

/** An isolated in-memory action store with the scripts' semantics. */
const store: EvalClient = {
  eval: async (script, keys, args) => {
    if (m.storeDown) throw new Error("ECONNREFUSED");
    const key = keys[0]!;
    if (script === PROPOSE_ACTION_SCRIPT) {
      if (m.store.has(key)) return 0;
      const [org, user, conversation, tool, input, digest, expiresAt] = args as string[];
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
    if (script === DECIDE_ACTION_SCRIPT) {
      const [org, user, conversation, digest, decision, now] = args as string[];
      const a = m.store.get(key);
      if (!a || a.org !== org || a.user !== user || a.conversation !== conversation) return [-1];
      if (Number(a.expiresAt) <= Number(now)) return [-1];
      if (a.status !== "pending") return [-3];
      if (a.digest !== digest) return [-4];
      a.status = decision!;
      return [1, a.tool, a.input];
    }
    throw new Error("unexpected script");
  },
};

vi.mock("@/server/integrations/redis", () => ({
  redis: { eval: (...a: Parameters<EvalClient["eval"]>) => store.eval(...a) },
  limitAiChat: vi.fn(async () => m.rate),
}));

import { POST as decideRoute } from "@/app/api/v1/ai/actions/[id]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const CONV = "44444444-4444-4444-8444-444444444444";
const OTHER_CONV = "55555555-5555-4555-8555-555555555555";
const me: ToolIdentity = { orgId: ORG, userId: USER, role: "MEMBER", actorType: "user" };
const at = (offsetMs = 0) => new Date(m.now + offsetMs);
const booking = (overrides: Record<string, unknown> = {}) => ({
  title: "Demo",
  startsAt: "2026-10-05T09:00:00.000Z",
  durationMinutes: 30,
  ...overrides,
});

async function propose(name: string, input: unknown, identity = me, conversation = CONV) {
  const p = await proposeToolAction(store, identity, conversation, name, input, at());
  return p;
}
const decide = (
  action: ProposedAction,
  overrides: Partial<{
    identity: ToolIdentity;
    conversationId: string;
    digest: string;
    decision: "confirm" | "cancel";
    id: string;
    offsetMs: number;
  }> = {},
) =>
  decideToolAction(
    store,
    overrides.identity ?? me,
    {
      id: overrides.id ?? action.id,
      conversationId: overrides.conversationId ?? action.conversationId,
      digest: overrides.digest ?? action.digest,
      decision: overrides.decision ?? "confirm",
    },
    at(overrides.offsetMs ?? 1_000),
  );

const nothingWritten = () => {
  expect(m.tx.calendarEvent.create).not.toHaveBeenCalled();
  expect(m.contactCreate).not.toHaveBeenCalled();
  expect(m.activityCreate).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  m.store.clear();
  m.storeDown = false;
  m.ctx = { orgId: ORG, userId: USER, role: "MEMBER" };
  m.rate = { success: true };
  m.tx.calendarEvent.findFirst.mockResolvedValue(null);
  m.tx.calendarEvent.create.mockResolvedValue({ id: "evt-1" });
  m.tx.contact.findFirstOrThrow.mockResolvedValue({ id: "c" });
  m.contactCreate.mockResolvedValue({ id: "contact-1" });
  m.contactFindFirst.mockResolvedValue({ firstName: "Maija", lastName: "Meikäläinen" });
  m.activityCreate.mockResolvedValue({ id: "act-1" });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("proposing a write (what the model's tool call does)", () => {
  it("1. a read-only tool runs at once, with no confirmation", async () => {
    const result = JSON.parse(
      await executeTool(me, "getCalendarAvailability", { date: "2026-10-05" }),
    );
    expect(result.freeSlots).toBeInstanceOf(Array);
    expect(m.store.size).toBe(0);
  });

  it("2. a write is only stored: nothing is created until the user confirms", async () => {
    for (const [name, input] of [
      ["bookMeeting", booking()],
      ["createContact", { firstName: "Maija", email: "maija@example.com" }],
      ["logActivity", { contactId: OTHER_CONV, type: "NOTE", subject: "Soitettu" }],
    ] as const) {
      const p = await propose(name, input);
      expect(p.action?.tool).toBe(name);
      expect(JSON.parse(p.modelResult)).toMatchObject({ status: "awaiting_user_confirmation" });
    }
    nothingWritten();
    expect(m.audit).not.toHaveBeenCalled();
    expect(m.store.size).toBe(3);
  });

  it("shows the resolved details the user confirms (contact name, duration, timezone)", async () => {
    const p = await propose(
      "bookMeeting",
      booking({ durationMinutes: undefined, contactId: OTHER_CONV }),
    );
    expect(p.action?.details).toEqual({
      tool: "bookMeeting",
      title: "Demo",
      startsAt: "2026-10-05T09:00:00.000Z",
      durationMinutes: 30, // resolved now; what runs is what was shown
      timezone: "Europe/Helsinki",
      contactName: "Maija Meikäläinen",
    });
  });

  it("every stored argument is shown to the user (free-form text in full), or accounted for", async () => {
    const longNotes = "Agenda:\n" + "x".repeat(1_990);
    const cases = [
      ["bookMeeting", booking({ contactId: OTHER_CONV, notes: longNotes, serviceName: "Demo" })],
      [
        "logActivity",
        {
          contactId: OTHER_CONV,
          type: "TASK",
          subject: "Soita",
          body: "Muista hinta",
          dueAt: "2026-10-06T08:00:00.000Z",
        },
      ],
      [
        "createContact",
        { firstName: "Maija", lastName: "M", email: "m@example.com", phone: "+358401" },
      ],
    ] as const;
    // Stored but not displayed as-is: ids are shown as the contact's name; a
    // service name is shown as its resolved duration; `source` is metadata.
    const accounted = new Set(["contactId", "serviceName", "source"]);
    for (const [name, input] of cases) {
      const p = await propose(name, input);
      const stored = JSON.parse(m.store.get(`ai:action:${p.action!.id}`)!.input!) as Record<
        string,
        unknown
      >;
      const shown = p.action!.details as Record<string, unknown>;
      for (const [key, value] of Object.entries(stored)) {
        if (accounted.has(key)) continue;
        expect(shown[key], `${name}.${key}`).toEqual(value);
      }
    }
    const notes = (await propose("bookMeeting", booking({ notes: longNotes }))).action!.details;
    expect(notes).toMatchObject({ notes: longNotes });
  });

  it("refuses before storing: invalid input, unknown tool, a read tool, a contact outside the org, no permission", async () => {
    expect(JSON.parse((await propose("bookMeeting", { title: "" })).modelResult).error).toBe(
      "invalid_input",
    );
    expect(JSON.parse((await propose("deleteEverything", {})).modelResult).error).toBe(
      "unknown_tool",
    );
    expect(JSON.parse((await propose("searchContacts", { query: "Ma" })).modelResult).error).toBe(
      "unknown_tool",
    );
    m.contactFindFirst.mockResolvedValueOnce(null);
    expect(
      JSON.parse(
        (await propose("logActivity", { contactId: OTHER_CONV, type: "NOTE", subject: "x" }))
          .modelResult,
      ).error,
    ).toBe("contact_not_found");
    const viewer = { ...me, role: "VIEWER" as const };
    expect(JSON.parse((await propose("bookMeeting", booking(), viewer)).modelResult).error).toBe(
      "permission_denied",
    );
    expect(m.store.size).toBe(0);
  });

  it("3. the model can't confirm by wording: extra 'confirmed' fields are rejected, and repeating the call only proposes again", async () => {
    const forged = await propose("bookMeeting", { ...booking(), confirmed: true });
    // Unknown keys are stripped by the schema: the call is still only a proposal.
    expect(forged.action).not.toBeNull();
    expect(JSON.stringify(forged.action?.details)).not.toContain("confirmed");
    const again = await propose("bookMeeting", booking());
    expect(again.action?.id).not.toBe(forged.action?.id);
    nothingWritten();
  });

  it("fails closed when the action store is unavailable (nothing pending, nothing written)", async () => {
    m.storeDown = true;
    const p = await propose("bookMeeting", booking());
    expect(p.action).toBeNull();
    expect(JSON.parse(p.modelResult).error).toBe("confirmation_unavailable");
    nothingWritten();
  });
});

describe("deciding (only the user, only once, only that action)", () => {
  it("10. confirm runs exactly the stored action once (happy path)", async () => {
    const { action } = await propose("bookMeeting", booking());
    const outcome = await decide(action!);
    expect(outcome).toEqual({
      ok: true,
      tool: "bookMeeting",
      status: "done",
      result: { booked: true, eventId: "evt-1", startsAt: "2026-10-05T09:00:00.000Z" },
    });
    expect(m.tx.calendarEvent.create).toHaveBeenCalledTimes(1);
    expect(m.tx.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG,
          title: "Demo",
          startsAt: new Date("2026-10-05T09:00:00.000Z"),
          endsAt: new Date("2026-10-05T09:30:00.000Z"),
        }),
      }),
    );
  });

  it("createContact and logActivity also run after confirmation", async () => {
    const c = (await propose("createContact", { firstName: "Maija" })).action!;
    expect(await decide(c)).toMatchObject({
      ok: true,
      status: "done",
      result: { id: "contact-1" },
    });
    const l = (
      await propose("logActivity", { contactId: OTHER_CONV, type: "TASK", subject: "Soita" })
    ).action!;
    expect(await decide(l)).toMatchObject({ ok: true, status: "done", result: { id: "act-1" } });
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
    expect(m.activityCreate).toHaveBeenCalledTimes(1);
  });

  it("4. confirming action A can't authorize action B", async () => {
    const a = (await propose("createContact", { firstName: "Maija" })).action!;
    const b = (await propose("bookMeeting", booking())).action!;
    expect(await decide(b, { digest: a.digest })).toEqual({ ok: false, reason: "mismatch" });
    nothingWritten();
  });

  it("5. changed arguments are a new action: the old confirmation runs only the old arguments", async () => {
    const nine = (await propose("bookMeeting", booking())).action!;
    const ten = (await propose("bookMeeting", booking({ startsAt: "2026-10-05T10:00:00.000Z" })))
      .action!;
    expect(ten.digest).not.toBe(nine.digest);
    // The 09:00 confirmation can't be used for the 10:00 action.
    expect(await decide(ten, { digest: nine.digest })).toEqual({ ok: false, reason: "mismatch" });
    expect(await decide(nine)).toMatchObject({ ok: true, status: "done" });
    expect(m.tx.calendarEvent.create).toHaveBeenCalledTimes(1);
    expect(m.tx.calendarEvent.create.mock.calls[0]![0].data.startsAt).toEqual(
      new Date("2026-10-05T09:00:00.000Z"),
    );
    expect(actionDigest("bookMeeting", { b: 1, a: 2 })).toBe(
      actionDigest("bookMeeting", { a: 2, b: 1 }),
    );
  });

  it("6. another organization, user or conversation can't use it (and can't tell it exists)", async () => {
    const a = (await propose("bookMeeting", booking())).action!;
    for (const overrides of [
      { identity: { ...me, orgId: OTHER_ORG } },
      { identity: { ...me, userId: OTHER_USER } },
      { conversationId: OTHER_CONV },
    ]) {
      expect(await decide(a, overrides)).toEqual({ ok: false, reason: "not_found" });
    }
    nothingWritten();
    // Still pending for its owner.
    expect(await decide(a)).toMatchObject({ ok: true, status: "done" });
  });

  it("7. a replay or double submit runs it once", async () => {
    const a = (await propose("bookMeeting", booking())).action!;
    const results = await Promise.all([decide(a), decide(a), decide(a)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "already_decided")).toHaveLength(2);
    expect(await decide(a)).toEqual({ ok: false, reason: "already_decided" });
    expect(m.tx.calendarEvent.create).toHaveBeenCalledTimes(1);
  });

  it("8. an expired or unknown action fails safely", async () => {
    const a = (await propose("bookMeeting", booking())).action!;
    expect(await decide(a, { offsetMs: ACTION_TTL_SECONDS * 1000 })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await decide(a, { id: crypto.randomUUID() })).toEqual({
      ok: false,
      reason: "not_found",
    });
    nothingWritten();
  });

  it("9. the role is checked again when it runs (a downgraded user can't confirm)", async () => {
    const a = (await propose("bookMeeting", booking())).action!;
    expect(await decide(a, { identity: { ...me, role: "VIEWER" } })).toEqual({
      ok: false,
      reason: "permission_denied",
    });
    nothingWritten();
  });

  it("cancel discards it; it can't be confirmed afterwards", async () => {
    const a = (await propose("bookMeeting", booking())).action!;
    expect(await decide(a, { decision: "cancel" })).toEqual({
      ok: true,
      tool: "bookMeeting",
      status: "canceled",
    });
    expect(await decide(a)).toEqual({ ok: false, reason: "already_decided" });
    nothingWritten();
  });

  it("a taken slot is reported as not done; it isn't retried", async () => {
    m.tx.calendarEvent.findFirst.mockResolvedValueOnce({ id: "busy" });
    const a = (await propose("bookMeeting", booking())).action!;
    expect(await decide(a)).toEqual({
      ok: true,
      tool: "bookMeeting",
      status: "not_done",
      reason: "slot_taken",
    });
    expect(await decide(a)).toEqual({ ok: false, reason: "already_decided" });
  });

  it("a failure while running never leaks its message and isn't run again", async () => {
    m.contactCreate.mockRejectedValueOnce(new Error("db password=secret"));
    const a = (await propose("createContact", { firstName: "Maija" })).action!;
    const outcome = await decide(a);
    expect(outcome).toEqual({ ok: false, reason: "action_failed" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    expect(await decide(a)).toEqual({ ok: false, reason: "already_decided" });
  });

  it("diagnostics carry ids and outcomes, never the arguments", async () => {
    const info = vi.mocked(console.info);
    const a = (await propose("createContact", { firstName: "Maija", email: "maija@example.com" }))
      .action!;
    await decide(a);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('\\"phase\\":\\"proposed\\"');
    expect(logged).toContain('\\"phase\\":\\"confirmed\\"');
    expect(logged).not.toContain("Maija");
    expect(logged).not.toContain("example.com");
  });
});

describe("POST /api/v1/ai/actions/{id}", () => {
  const post = (
    id: string,
    body: unknown,
    headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
  ) =>
    decideRoute(
      new Request(`http://localhost/api/v1/ai/actions/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  const bodyFor = (a: ProposedAction, decision = "confirm") => ({
    decision,
    conversationId: a.conversationId,
    digest: a.digest,
  });

  it("the signed-in owner confirms: it runs once and is audited without its arguments", async () => {
    const a = (await propose("bookMeeting", booking())).action!;
    const res = await post(a.id, bodyFor(a));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: "done", tool: "bookMeeting" });
    expect(m.audit).toHaveBeenCalledWith(
      { orgId: ORG, userId: USER },
      expect.objectContaining({
        action: "ai_action.confirm",
        resourceType: "ai_action",
        resourceId: a.id,
        after: { tool: "bookMeeting", outcome: "done" },
      }),
    );
    const replay = await post(a.id, bodyFor(a));
    expect(replay.status).toBe(409);
    expect(m.tx.calendarEvent.create).toHaveBeenCalledTimes(1);
  });

  it("another organization's signed-in user gets 404 (the action is not revealed)", async () => {
    const a = (await propose("bookMeeting", booking())).action!;
    m.ctx = { orgId: OTHER_ORG, userId: OTHER_USER, role: "OWNER" };
    expect((await post(a.id, bodyFor(a))).status).toBe(404);
    nothingWritten();
  });

  it("a user downgraded to VIEWER after the proposal gets 403; nothing runs", async () => {
    const a = (await propose("bookMeeting", booking())).action!;
    // VIEWER has neither chat:use nor calendar:write. The per-tool re-check when
    // an action runs is proven directly in test 9 (no role has chat:use without the
    // write permissions, so the route's chat:use gate refuses first here).
    m.ctx = { orgId: ORG, userId: USER, role: "VIEWER" };
    expect((await post(a.id, bodyFor(a))).status).toBe(403);
    nothingWritten();
    m.ctx = { orgId: ORG, userId: USER, role: "MEMBER" };
    expect((await post(a.id, bodyFor(a))).status).toBe(200); // still pending for its owner
  });

  it.each([
    ["cross-origin", () => undefined, { "sec-fetch-site": "cross-site" }, 403],
    ["unauthenticated", () => (m.ctx = null), undefined, 401],
    ["rate limited", () => (m.rate = { success: false }), undefined, 429],
    ["store unavailable (fail closed)", () => (m.storeDown = true), undefined, 503],
  ])("refused: %s, nothing runs", async (_l, arrange, headers, status) => {
    const a = (await propose("bookMeeting", booking())).action!;
    arrange();
    const res = await post(a.id, bodyFor(a), headers);
    expect(res.status).toBe(status);
    nothingWritten();
  });

  it.each([
    ["a non-uuid id", "x", {}],
    ["an unknown decision", crypto.randomUUID(), { decision: "maybe" }],
    ["a malformed digest", crypto.randomUUID(), { digest: "abc" }],
    ["extra fields", crypto.randomUUID(), { extra: 1 }],
  ])("rejects %s (400)", async (_l, id, override) => {
    const body = {
      decision: "confirm",
      conversationId: CONV,
      digest: "a".repeat(64),
      ...override,
    };
    expect((await post(id, body)).status).toBe(400);
  });
});

describe("executeTool's own confirmation check (defence in depth)", () => {
  const owner: ToolIdentity = { ...me, role: "OWNER" };
  const writeCalls: Array<[string, Record<string, unknown>]> = [
    ["createContact", { firstName: "Maija", email: "maija@example.com" }],
    [
      "logActivity",
      { contactId: "66666666-6666-4666-8666-666666666666", type: "NOTE", subject: "Call" },
    ],
    ["bookMeeting", booking()],
    [
      "proposeBusinessDnaUpdate",
      {
        set: { displayName: "Autokorjaamo Virtanen" },
        basis: { exists: false, fields: { displayName: null } },
      },
    ],
  ];

  it("the tools requiring confirmation are exactly the four write tools", () => {
    expect([...WRITE_TOOL_NAMES].sort()).toEqual(
      ["bookMeeting", "createContact", "logActivity", "proposeBusinessDnaUpdate"].sort(),
    );
    expect(writeCalls.map(([name]) => name).sort()).toEqual([...WRITE_TOOL_NAMES].sort());
  });

  it("defaults to: every tool whose permission isn't a ':read' one; an explicit setting wins", () => {
    for (const tool of TOOL_REGISTRY) {
      expect(toolRequiresConfirmation(tool)).toBe(!tool.permission.endsWith(":read"));
    }
    expect(toolRequiresConfirmation({ permission: "crm:write" })).toBe(true);
    expect(toolRequiresConfirmation({ permission: "crm:read" })).toBe(false);
    expect(toolRequiresConfirmation({ permission: "crm:write", requiresConfirmation: false })).toBe(
      false,
    );
    expect(toolRequiresConfirmation({ permission: "crm:read", requiresConfirmation: true })).toBe(
      true,
    );
  });

  it.each(writeCalls)(
    "a user's %s call without a confirmed action is refused and writes nothing",
    async (name, input) => {
      const result = JSON.parse(await executeTool(owner, name, input));

      expect(result).toEqual({ error: "confirmation_required" });
      nothingWritten();
      expect(m.transaction).not.toHaveBeenCalled();
      expect(m.audit).not.toHaveBeenCalled();
    },
  );

  it("an action without an id is not a confirmed action", async () => {
    const result = JSON.parse(
      await executeTool(owner, "createContact", { firstName: "Maija" }, { action: {} }),
    );

    expect(result).toEqual({ error: "confirmation_required" });
    expect(m.contactCreate).not.toHaveBeenCalled();
  });

  it("checks input and permission first (their errors are unchanged)", async () => {
    expect(JSON.parse(await executeTool(owner, "createContact", {})).error).toBe("invalid_input");
    const viewer: ToolIdentity = { ...me, role: "VIEWER" };
    expect(JSON.parse(await executeTool(viewer, "createContact", { firstName: "Maija" }))).toEqual({
      error: "permission_denied",
    });
  });

  it("with a confirmed action the write tools run as before", async () => {
    const action = { action: { actionId: "a-1", conversationId: CONV } };

    expect(
      JSON.parse(await executeTool(me, "createContact", { firstName: "Maija" }, action)),
    ).toMatchObject({ id: "contact-1" });
    expect(
      JSON.parse(
        await executeTool(
          me,
          "logActivity",
          { contactId: "66666666-6666-4666-8666-666666666666", type: "NOTE", subject: "Call" },
          action,
        ),
      ),
    ).not.toHaveProperty("error");
    expect(JSON.parse(await executeTool(me, "bookMeeting", booking(), action))).toMatchObject({
      booked: true,
      eventId: "evt-1",
    });
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
    expect(m.activityCreate).toHaveBeenCalledTimes(1);
    expect(m.tx.calendarEvent.create).toHaveBeenCalledTimes(1);
  });

  it("the voice assistant's identity still runs createContact directly", async () => {
    const voice: ToolIdentity = { ...me, actorType: "voice_ai" };

    const result = JSON.parse(await executeTool(voice, "createContact", { firstName: "Maija" }));

    expect(result).toMatchObject({ id: "contact-1" });
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
  });

  it("read tools are unaffected: they run without an action", async () => {
    expect(READ_ONLY_TOOL_NAMES.some((n) => WRITE_TOOL_NAMES.includes(n))).toBe(false);
    for (const [name, input] of [
      ["searchKnowledgeBase", { query: "prices" }],
      ["searchContacts", { query: "Maija" }],
      ["getCalendarAvailability", { date: "2026-10-05" }],
    ] as const) {
      expect(JSON.parse(await executeTool(me, name, input))).not.toHaveProperty("error");
    }
  });
});
