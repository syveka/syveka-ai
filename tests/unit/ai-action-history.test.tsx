// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * A reopened conversation shows each saved AI write action with its
 * RECORDED outcome. Lifecycle under test: proposal (real proposeToolAction)
 * -> saved with the reply (as the chat route saves it) -> decided through
 * the real POST /api/v1/ai/actions/{id} -> audit row -> reopened (real
 * restore functions) -> real confirmation card.
 *
 * Mocked: the database (contacts, audit table honouring the organization
 * filter), session, an isolated in-memory action store with the scripts'
 * semantics (the Lua runs against real Redis in ai-tool-actions-redis).
 */
const m = vi.hoisted(() => ({
  contactCreate: vi.fn(),
  auditRows: [] as Array<{
    organizationId: string;
    action: string;
    resourceType: string;
    resourceId: string | null;
    after: unknown;
    createdAt: Date;
  }>,
  ctx: null as null | { orgId: string; userId: string; role: string },
  /** Make the next audit write of this action name throw (a failed record). */
  failAudit: null as null | string,
  store: new Map<string, Record<string, string>>(),
  now: Date.now(),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    contact: {
      create: m.contactCreate,
      findFirst: vi.fn(async () => null),
      findFirstOrThrow: vi.fn(async () => ({ id: "c" })),
    },
    businessDnaService: { findFirst: vi.fn(async () => null) },
    availabilitySchedule: { findFirst: vi.fn(async () => null) },
  })),
  unscopedPrisma: {
    auditLog: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            organizationId: string;
            resourceType: string;
            resourceId: { in: string[] };
            action: { in: string[] };
          };
        }) =>
          m.auditRows.filter(
            (r) =>
              r.organizationId === where.organizationId &&
              r.resourceType === where.resourceType &&
              where.resourceId.in.includes(r.resourceId ?? "") &&
              where.action.in.includes(r.action),
          ),
      ),
    },
  },
}));
vi.mock("@/server/services/audit", () => ({
  audit: vi.fn(
    async (
      ctx: { orgId: string },
      input: { action: string; resourceType: string; resourceId?: string; after?: unknown },
    ) => {
      if (m.failAudit === input.action) {
        m.failAudit = null;
        throw new Error("audit store unavailable");
      }
      m.auditRows.push({
        organizationId: ctx.orgId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        after: input.after ?? null,
        createdAt: new Date(),
      });
    },
  ),
}));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn(async () => []) }));
vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => {
    if (!m.ctx) throw new Error("unauthenticated");
    return m.ctx;
  }),
}));

import {
  ACTION_STATUS_SCRIPT,
  DECIDE_ACTION_SCRIPT,
  PROPOSE_ACTION_SCRIPT,
  decideToolAction,
  proposeToolAction,
  type EvalClient,
} from "@/server/ai/tool-actions";
import {
  liveStatuses,
  recordedActionOutcomes,
  restoredState,
  savedActions,
} from "@/server/ai/tool-action-history";

const store: EvalClient = {
  eval: async (script, keys, args) => {
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
    if (script === ACTION_STATUS_SCRIPT) {
      const [org, user, conversation] = args as string[];
      const a = m.store.get(key);
      if (!a || a.org !== org || a.user !== user || a.conversation !== conversation) return "";
      return a.status;
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
  limitAiChat: vi.fn(async () => ({ success: true })),
}));

import { POST as decideRoute } from "@/app/api/v1/ai/actions/[id]/route";
import { ActionConfirmation } from "@/components/chat/action-confirmation";

// The card links to Business DNA settings; next-intl's navigation needs the
// Next.js runtime, so tests render it as a plain link.
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"));
const ar = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../messages/ar.json"), "utf8"));
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const me = { orgId: ORG, userId: USER, role: "MEMBER" as const, actorType: "user" as const };

beforeEach(() => {
  vi.clearAllMocks();
  m.store.clear();
  m.auditRows = [];
  m.ctx = { orgId: ORG, userId: USER, role: "MEMBER" };
  m.failAudit = null;
  m.contactCreate.mockResolvedValue({ id: "contact-1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(cleanup);

/** Proposal, saved with the reply the way the chat route saves its tool-call log. */
async function proposeAndSave(firstName = "QA Confirm Test 3") {
  const { action } = await proposeToolAction(store, me, CONV, "createContact", { firstName });
  const savedToolCalls = JSON.parse(
    JSON.stringify([{ name: "createContact", ok: true, action }]), // through the JSON column
  );
  return { action: action!, savedToolCalls };
}
const decide = (
  a: { id: string; digest: string },
  decision: "confirm" | "cancel",
  conversationId = CONV,
) =>
  decideRoute(
    new Request(`http://localhost/api/v1/ai/actions/${a.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ decision, conversationId, digest: a.digest }),
    }),
    { params: Promise.resolve({ id: a.id }) },
  );

/** Reopening: what the chat page builds for the card (with the live store). */
async function reopen(
  savedToolCalls: unknown,
  orgId = ORG,
  now = Date.now(),
  liveStore: EvalClient = store,
) {
  const actions = savedActions(savedToolCalls);
  const recorded = await recordedActionOutcomes(
    orgId,
    actions.map((a) => a.id),
  );
  const live = await liveStatuses(liveStore, { orgId, userId: USER }, actions, recorded, now);
  return actions.map((a) => {
    const state = restoredState(a, recorded, now, live.get(a.id));
    return state === "pending" ? a : { ...a, restored: state };
  });
}
function showCard(action: Parameters<typeof ActionConfirmation>[0]["action"], messages = en) {
  return render(
    <NextIntlClientProvider locale={messages === ar ? "ar" : "en"} messages={messages}>
      <ActionConfirmation action={action} />
    </NextIntlClientProvider>,
  );
}
const confirmButton = () => screen.queryByRole("button", { name: en.chat.actions.confirm });

describe("reopening a conversation shows the recorded outcome", () => {
  it("Confirm -> reopen: completed, no executable Confirm, and it can't run again", async () => {
    const { action, savedToolCalls } = await proposeAndSave();
    expect((await decide(action, "confirm")).status).toBe(200);
    expect(m.contactCreate).toHaveBeenCalledTimes(1);

    const [restored] = await reopen(savedToolCalls);
    expect(restored).toMatchObject({ id: action.id, restored: "done" });
    showCard(restored!);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.done);
    expect(confirmButton()).toBeNull();
    // A replay (refresh, back navigation, repeated taps) never runs it twice.
    expect((await decide(action, "confirm")).status).toBe(409);
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
  });

  it("Cancel -> reopen: canceled, nothing written", async () => {
    const { action, savedToolCalls } = await proposeAndSave("QA Cancel Test 2");
    expect((await decide(action, "cancel")).status).toBe(200);
    const [restored] = await reopen(savedToolCalls);
    expect(restored).toMatchObject({ restored: "canceled" });
    showCard(restored!);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.canceled);
    expect(confirmButton()).toBeNull();
    expect(m.contactCreate).not.toHaveBeenCalled();
  });

  it("expired without a decision -> reopen: 'no result recorded', not executable, not 'done' or 'canceled'", async () => {
    const { savedToolCalls } = await proposeAndSave();
    const [restored] = await reopen(savedToolCalls, ORG, Date.now() + 11 * 60_000);
    expect(restored).toMatchObject({ restored: "unavailable" });
    showCard(restored!);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.unavailable);
    expect(confirmButton()).toBeNull();
    expect(m.contactCreate).not.toHaveBeenCalled();
  });

  it("an error while the tool ran is recorded and shown as unknown (not failed), and can't run again", async () => {
    m.contactCreate.mockRejectedValueOnce(new Error("db down"));
    const { action, savedToolCalls } = await proposeAndSave();
    const res = await decide(action, "confirm");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("action_failed");
    const [restored] = await reopen(savedToolCalls);
    expect(restored).toMatchObject({ restored: "unknown" });
    showCard(restored!);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.unknown);
    expect(confirmButton()).toBeNull();
    expect((await decide(action, "confirm")).status).toBe(409);
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
  });

  it("concurrent and repeated confirmations create one record and one recorded outcome", async () => {
    const { action, savedToolCalls } = await proposeAndSave();
    // Concurrent decisions (atomic store): exactly one runs.
    const request = {
      id: action.id,
      conversationId: CONV,
      digest: action.digest,
      decision: "confirm" as const,
    };
    const results = await Promise.all([1, 2, 3].map(() => decideToolAction(store, me, request)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "already_decided")).toHaveLength(2);
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
    // Through the endpoint (sequential: concurrent dynamic imports of mocked
    // modules aren't reliable in the test runner), every repeat is refused and
    // nothing more is recorded.
    const second = await proposeAndSave("QA Confirm Test 4");
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await decide(second.action, "confirm")).status);
    expect(statuses).toEqual([200, 409, 409]);
    expect(m.contactCreate).toHaveBeenCalledTimes(2);
    expect(m.auditRows.filter((r) => r.resourceId === second.action.id)).toHaveLength(1);
    expect((await reopen(second.savedToolCalls))[0]).toMatchObject({ restored: "done" });
    void savedToolCalls;
  });

  it("still pending when reopened: the card stays executable (the server still decides)", async () => {
    const { savedToolCalls } = await proposeAndSave();
    const [restored] = await reopen(savedToolCalls);
    expect(restored).not.toHaveProperty("restored");
    showCard(restored!);
    expect(confirmButton()).not.toBeNull();
  });

  it("is localized (Arabic)", async () => {
    const { action, savedToolCalls } = await proposeAndSave();
    await decide(action, "cancel");
    showCard((await reopen(savedToolCalls))[0]!, ar);
    expect(screen.getByRole("status").textContent).toBe(ar.chat.actions.result.canceled);
  });
});

describe("tenant isolation and legacy data", () => {
  it("another organization can neither settle the action nor read its outcome", async () => {
    const { action, savedToolCalls } = await proposeAndSave();
    m.ctx = { orgId: OTHER_ORG, userId: USER, role: "OWNER" };
    expect((await decide(action, "confirm")).status).toBe(404);
    expect(m.contactCreate).not.toHaveBeenCalled();
    expect(m.auditRows).toHaveLength(0);

    m.ctx = { orgId: ORG, userId: USER, role: "MEMBER" };
    await decide(action, "confirm");
    // The other organization's view of the same action id finds no outcome.
    const other = await recordedActionOutcomes(OTHER_ORG, [action.id]);
    expect(other.size).toBe(0);
    expect((await reopen(savedToolCalls))[0]).toMatchObject({ restored: "done" });
  });

  it("legacy messages (tool log without an action) and malformed entries restore nothing", async () => {
    expect(savedActions([{ name: "createContact", ok: true }])).toEqual([]);
    expect(savedActions(null)).toEqual([]);
    expect(savedActions("x")).toEqual([]);
    expect(
      savedActions([
        { name: "createContact", ok: true, action: { id: "not-a-uuid", tool: "createContact" } },
        { name: "createContact", ok: true, action: { id: crypto.randomUUID() } },
      ]),
    ).toEqual([]);
    expect(await recordedActionOutcomes(ORG, [])).toEqual(new Map());
  });

  it("an outcome is never inferred from wording: no audit record means no done/canceled", async () => {
    const { savedToolCalls } = await proposeAndSave();
    // A contact with the same name exists, but nothing was recorded for this action.
    m.contactCreate.mockClear();
    const [restored] = await reopen(savedToolCalls, ORG, Date.now() + 11 * 60_000);
    expect(restored).toMatchObject({ restored: "unavailable" });
  });
});

describe("a successful write whose result couldn't be recorded", () => {
  it("contact created, outcome record fails: the response still says done; reopen shows unknown; never runs again", async () => {
    const { action, savedToolCalls } = await proposeAndSave("QA Unrecorded");
    m.failAudit = "ai_action.confirm";
    const res = await decide(action, "confirm");
    expect(res.status).toBe(200); // the write happened: never reported as failed
    expect((await res.json()).data).toMatchObject({ status: "done" });
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
    expect(m.auditRows.filter((r) => r.resourceId === action.id)).toHaveLength(0);
    // Logged without content.
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("ai_tool_action_audit_failed");
    expect(logged).not.toContain("QA Unrecorded");

    // Reopened while the live store still holds it: decided, no record -> unknown.
    const [soon] = await reopen(savedToolCalls);
    expect(soon).toMatchObject({ restored: "unknown" });
    showCard(soon!);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.unknown);
    expect(confirmButton()).toBeNull();
    // Reopened after expiry: still no claim either way.
    const [later] = await reopen(savedToolCalls, ORG, Date.now() + 11 * 60_000);
    expect(later).toMatchObject({ restored: "unavailable" });
    // A retry can't run it again.
    expect((await decide(action, "confirm")).status).toBe(409);
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
  });

  it("contact created, the tool's own audit then fails: shown and recorded as unknown, not failed", async () => {
    const { action, savedToolCalls } = await proposeAndSave("QA Tool Audit");
    m.failAudit = "contact.create"; // after the row was created
    const res = await decide(action, "confirm");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("action_failed");
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
    expect(m.auditRows.find((r) => r.resourceId === action.id)?.after).toMatchObject({
      outcome: "unknown",
    });
    expect((await reopen(savedToolCalls))[0]).toMatchObject({ restored: "unknown" });
    expect((await decide(action, "confirm")).status).toBe(409);
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
  });
});

describe("reopened actions without a record: only a live pending action is actionable", () => {
  it("still pending in the live store and unexpired: Confirm/Cancel stay, and Confirm runs once", async () => {
    const { action, savedToolCalls } = await proposeAndSave();
    const [restored] = await reopen(savedToolCalls);
    expect(restored).not.toHaveProperty("restored");
    showCard(restored!);
    expect(confirmButton()).not.toBeNull();
    expect(screen.getByRole("button", { name: en.chat.actions.cancel })).toBeTruthy();
    expect((await decide(action, "confirm")).status).toBe(200);
    expect((await decide(action, "confirm")).status).toBe(409);
    expect(m.contactCreate).toHaveBeenCalledTimes(1);
  });

  it("consumed in the live store without a record: unknown, not executable", async () => {
    const { action, savedToolCalls } = await proposeAndSave();
    m.store.get(`ai:action:${action.id}`)!.status = "confirmed";
    const [restored] = await reopen(savedToolCalls);
    expect(restored).toMatchObject({ restored: "unknown" });
    showCard(restored!);
    expect(confirmButton()).toBeNull();
  });

  it("gone from the live store before expiry: no result recorded, not executable", async () => {
    const { action, savedToolCalls } = await proposeAndSave();
    m.store.delete(`ai:action:${action.id}`);
    expect((await reopen(savedToolCalls))[0]).toMatchObject({ restored: "unavailable" });
  });

  it("the live store can't be read: fails closed (unknown, not executable)", async () => {
    const { savedToolCalls } = await proposeAndSave();
    const down: EvalClient = {
      eval: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    const [restored] = await reopen(savedToolCalls, ORG, Date.now(), down);
    expect(restored).toMatchObject({ restored: "unknown" });
  });

  it("another user's live action is never offered (owner-scoped read)", async () => {
    const { action, savedToolCalls } = await proposeAndSave();
    const actions = savedActions(savedToolCalls);
    const live = await liveStatuses(
      store,
      { orgId: ORG, userId: "33333333-3333-4333-8333-333333333333" },
      actions,
      new Map(),
    );
    expect(live.get(action.id)).toBe("missing");
    expect(restoredState(actions[0]!, new Map(), Date.now(), live.get(action.id))).toBe(
      "unavailable",
    );
  });
});
