import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which CRM contact a phone call is linked to. The post-call job used to match a stored
 * phone exactly (whitespace removed), so "+358 40-123 4567" in the CRM never matched a
 * caller "+358401234567" and a duplicate contact was created; and its lock was per call,
 * so two different calls from the same new caller, processed at once, each created one.
 *
 * The database is an in-memory model: the contact lookup applies the query's own
 * parameters (organization, the formatting pattern as a regular expression, the accepted
 * forms), and advisory locks are one mutex per key held until the transaction ends.
 * Synthetic data; no provider is called. Real-Postgres coverage of the same scenarios is
 * in post-call-concurrency.postgres.test.ts (runs only with VOICE_PG_URL).
 */

type Row = Record<string, unknown>;
const NBSP = String.fromCharCode(0xa0);
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => {
  const held = new Map<string, Promise<void>>();
  const h = {
    calls: [] as Row[],
    contacts: [] as Row[],
    lockKeys: [] as string[],
    lookups: 0,
    /** The text of the last contact lookup query. */
    lookupSql: "",
    /** Called when a run finds a lock held by another run. */
    onContention: undefined as (() => void) | undefined,
    /** Awaited after each contact lookup, before the run may create. */
    afterLookup: async () => {},
    acquire: async (key: string): Promise<() => void> => {
      if (held.has(key)) h.onContention?.();
      while (held.has(key)) await held.get(key);
      let release = () => {};
      held.set(key, new Promise<void>((resolve) => (release = resolve)));
      return () => {
        held.delete(key);
        release();
      };
    },
    seq: 0,
  };
  return h;
});

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (r: Request) => r.text() }));
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: vi.fn(async () => true),
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/ai/router", () => ({
  routeModel: () => ({ model: "synthetic", maxTokens: 64 }),
}));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: {
    messages: {
      create: vi.fn(async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ summary: "Synthetic.", sentiment: "neutral", followUps: [] }),
          },
        ],
      })),
    },
  },
}));
vi.mock("@/server/services/billing/entitlements", () => ({ recordUsage: vi.fn(async () => {}) }));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: vi.fn(async () => {}) }));
vi.mock("@/server/db/tenant", () => {
  const db: Record<string, unknown> = {
    voiceCall: {
      findFirst: async ({ where }: { where: Row }) => {
        const call = h.calls.find(
          (c) => c.vapiCallId === where.vapiCallId && c.organizationId === where.organizationId,
        );
        return call ? { ...call, assistant: { name: "Synthetic", language: "EN" } } : null;
      },
      update: async ({ where, data }: { where: Row; data: Row }) =>
        Object.assign(
          h.calls.find((c) => c.id === where.id)!,
          data,
        ),
    },
    usageRecord: { findFirst: async () => null },
    contact: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: `contact-new-${++h.seq}`,
          createdAt: new Date(),
          deletedAt: null,
          ...data,
        };
        h.contacts.push(row);
        return row;
      },
    },
    activity: { findFirst: async () => null, create: async ({ data }: { data: Row }) => data },
    organizationMember: { findFirst: async () => null },
    notification: { findFirst: async () => null, create: async () => ({}) },
    // The post-call job's only raw query: contacts by phone, oldest first, at most two.
    $queryRaw: async (
      sql: TemplateStringsArray,
      orgId: unknown,
      pattern: unknown,
      forms: unknown,
    ) => {
      h.lookups += 1;
      h.lookupSql = sql.join("?");
      const separators = new RegExp(pattern as string, "g");
      const found = h.contacts
        .filter(
          (c) =>
            c.organizationId === orgId &&
            c.deletedAt === null &&
            typeof c.phone === "string" &&
            (forms as string[]).includes(c.phone.replace(separators, "")),
        )
        .sort(
          (a, b) =>
            (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime() ||
            String(a.id).localeCompare(String(b.id)),
        )
        .slice(0, 2)
        .map((c) => ({ id: c.id }));
      await h.afterLookup();
      return found;
    },
  };
  db.$transaction = async (step: (tx: unknown) => Promise<unknown>) => {
    const releases: Array<() => void> = [];
    const tx = {
      ...db,
      $executeRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
        const key = values.join(":");
        h.lockKeys.push(key);
        releases.push(await h.acquire(key));
        return 1;
      },
    };
    try {
      return await step(tx);
    } finally {
      for (const release of releases) release();
    }
  };
  return { unscopedPrisma: db };
});

import { POST } from "@/app/api/v1/jobs/post-call/route";
import {
  PHONE_SEPARATOR_SQL_PATTERN,
  callerPhoneIdentity,
  compactPhone,
} from "@/lib/crm/phone-identity";

let callSeq = 0;
function seedCall(orgId: string, callerNumber: string | null, status = "COMPLETED") {
  const n = ++callSeq;
  const call = {
    id: `call-row-${n}`,
    vapiCallId: `vapi-${n}`,
    organizationId: orgId,
    contactId: null,
    callerNumber,
    status,
    durationSeconds: 60,
    transcript: [{ role: "user", message: "a synthetic transcript" }],
    summary: null,
    sentiment: null,
    actionsTaken: null,
    postCallProcessedAt: null,
  };
  h.calls.push(call);
  return call;
}

let contactSeq = 0;
function seedContact(orgId: string, phone: string | null, extra: Row = {}) {
  const row = {
    id: `contact-existing-${++contactSeq}`,
    organizationId: orgId,
    firstName: "Synthetic",
    phone,
    createdAt: new Date(Date.UTC(2026, 0, contactSeq)),
    deletedAt: null,
    ...extra,
  };
  h.contacts.push(row);
  return { ...row };
}

type Call = { organizationId: string; vapiCallId: string };
const run = (call: Call) =>
  POST(
    new Request("http://localhost/api/v1/jobs/post-call", {
      method: "POST",
      body: JSON.stringify({ orgId: call.organizationId, vapiCallId: call.vapiCallId }),
    }),
  );

const contactOf = (call: { id: string }) => h.calls.find((c) => c.id === call.id)!.contactId;
const contactsIn = (orgId: string) => h.contacts.filter((c) => c.organizationId === orgId);

beforeEach(() => {
  h.calls = [];
  h.contacts = [];
  h.lockKeys = [];
  h.lookups = 0;
  h.onContention = undefined;
  h.afterLookup = async () => {};
});
afterEach(() => vi.restoreAllMocks());

describe("callerPhoneIdentity", () => {
  it.each([
    ["+358401234567", "+358401234567"],
    ["+358 40 123 4567", "+358401234567"],
    ["+358-40-123-4567", "+358401234567"],
    ["+358 (40) 123.45/67", "+358401234567"],
    [`+358${NBSP}40${NBSP}1234567`, "+358401234567"],
    ["00358401234567", "+358401234567"],
    ["+1 (415) 555-0100", "+14155550100"],
  ])("%j is the international number %s", (raw, canonical) => {
    expect(callerPhoneIdentity(raw)).toEqual({
      kind: "international",
      canonical,
      matchForms: [canonical, `00${canonical.slice(1)}`],
    });
  });

  it("a number with no international prefix matches only the same digits, and no country is assumed", () => {
    expect(callerPhoneIdentity("040 123 4567")).toEqual({
      kind: "unqualified",
      canonical: "0401234567",
      matchForms: ["0401234567"],
    });
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["anonymous"],
    ["Unknown"],
    ["sip:caller@example.test"],
    ["+358401234567;ext=12"],
    ["+358401234567 x12"],
    ["+358401234567#12"],
    ["+0401234567"],
    ["+12345"],
    ["+1234567890123456"],
    ["123"],
    ["1234567890123456"],
  ])("%j identifies no one", (raw) => {
    expect(callerPhoneIdentity(raw)).toBeNull();
  });

  it("the SQL pattern removes exactly the characters the JavaScript comparison removes", () => {
    const sql = new RegExp(PHONE_SEPARATOR_SQL_PATTERN, "g");
    for (const sample of [
      "+358 (40) 123-45.67/8",
      `040\t123${NBSP}4567`,
      "+358401234567;ext=1",
      "a-b_c",
      "[0]40\\1",
    ]) {
      expect(sample.replace(sql, "")).toBe(compactPhone(sample));
    }
  });
});

describe("post-call contact linking", () => {
  it.each([
    "+358 40 123 4567",
    "+358-40-123-4567",
    "+358 (40) 123 45 67",
    "00358 40 123 4567",
    "+358401234567",
  ])(
    "an existing contact saved as %j is linked, and nothing is created or changed",
    async (stored) => {
      const existing = seedContact(ORG_A, stored);
      const call = seedCall(ORG_A, "+358401234567");

      expect((await run(call)).status).toBe(200);

      expect(contactOf(call)).toBe(existing.id);
      expect(contactsIn(ORG_A)).toEqual([existing]);
    },
  );

  it("the lookup is scoped to the organization and to contacts not deleted, oldest first", async () => {
    // The in-memory model applies these rules itself; this pins them in the query.
    await run(seedCall(ORG_A, "+358401234567"));

    const sql = h.lookupSql.replace(/\s+/g, " ");
    expect(sql).toContain("WHERE organization_id = ?::uuid");
    expect(sql).toContain("AND deleted_at IS NULL");
    expect(sql).toContain("regexp_replace(phone, ?, '', 'g') = ANY(?::text[])");
    expect(sql).toContain("ORDER BY created_at ASC, id ASC");
  });

  it("a caller number in another formatting finds the contact the same way", async () => {
    const existing = seedContact(ORG_A, "+358401234567");
    const call = seedCall(ORG_A, "00358 40 123 4567");

    await run(call);

    expect(contactOf(call)).toBe(existing.id);
    expect(contactsIn(ORG_A)).toHaveLength(1);
  });

  it("a national-format contact is not assumed to be the international caller: a new contact, the old one untouched", async () => {
    const national = seedContact(ORG_A, "040 123 4567");
    const call = seedCall(ORG_A, "+358401234567");

    await run(call);

    const created = contactsIn(ORG_A).find((c) => c.id !== national.id)!;
    expect(contactOf(call)).toBe(created.id);
    expect(created).toMatchObject({ phone: "+358401234567", source: "voice-ai" });
    expect(contactsIn(ORG_A).find((c) => c.id === national.id)).toEqual(national);
  });

  it("a caller with no international prefix matches the same digits only", async () => {
    const national = seedContact(ORG_A, "040-123 4567");
    seedContact(ORG_A, "+358401234567");
    const call = seedCall(ORG_A, "0401234567");

    await run(call);

    expect(contactOf(call)).toBe(national.id);
    expect(contactsIn(ORG_A)).toHaveLength(2);
  });

  it("another organization's contact with the same number is never linked or changed", async () => {
    const other = seedContact(ORG_B, "+358 40 123 4567");
    const call = seedCall(ORG_A, "+358401234567");

    await run(call);

    expect(contactOf(call)).not.toBe(other.id);
    expect(contactsIn(ORG_A)).toHaveLength(1);
    expect(contactsIn(ORG_B)).toEqual([other]);
  });

  it("a deleted contact is not linked; a new contact is created and the deleted one stays deleted", async () => {
    const deleted = seedContact(ORG_A, "+358401234567", { deletedAt: new Date("2026-09-01") });
    const call = seedCall(ORG_A, "+358401234567");

    await run(call);

    expect(contactOf(call)).not.toBe(deleted.id);
    expect(contactsIn(ORG_A)).toHaveLength(2);
    expect(contactsIn(ORG_A).find((c) => c.id === deleted.id)).toEqual(deleted);
  });

  it("several contacts with the number: the oldest is linked, none are merged or changed, and the log has no number", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oldest = seedContact(ORG_A, "+358 40 123 4567");
    const newer = seedContact(ORG_A, "00358401234567");
    const call = seedCall(ORG_A, "+358401234567");

    await run(call);

    expect(contactOf(call)).toBe(oldest.id);
    expect(contactsIn(ORG_A)).toEqual([oldest, newer]);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("post_call_contact_multiple_matches");
    expect(logged).not.toMatch(/358|4567/);
  });

  it.each([[null], ["anonymous"], ["sip:caller@example.test"], ["+358401234567;ext=5"]])(
    "a caller %j identifies no one: no lookup, no contact, the call still completes",
    async (callerNumber) => {
      seedContact(ORG_A, "anonymous");
      const call = seedCall(ORG_A, callerNumber);

      const response = await run(call);

      expect(await response.json()).toEqual({ ok: true });
      expect(h.lookups).toBe(0);
      expect(contactOf(call)).toBeNull();
      expect(contactsIn(ORG_A)).toHaveLength(1);
      expect(h.calls[0]!.postCallProcessedAt).toBeInstanceOf(Date);
    },
  );

  it("an unfinished call is linked to an existing contact but never creates one", async () => {
    const call = seedCall(ORG_A, "+358401234567", "FAILED");

    await run(call);

    expect(contactsIn(ORG_A)).toHaveLength(0);
    expect(contactOf(call)).toBeNull();
  });

  it("a retry after the contact was linked looks nothing up and creates nothing", async () => {
    const call = seedCall(ORG_A, "+358401234567");
    await run(call);
    const linked = contactOf(call);
    h.calls[0]!.postCallProcessedAt = null; // a later step failed; QStash retries
    h.lookups = 0;

    await run(call);

    expect(h.lookups).toBe(0);
    expect(contactOf(call)).toBe(linked);
    expect(contactsIn(ORG_A)).toHaveLength(1);
  });
});

describe("post-call contact linking — different calls processed at the same time", () => {
  /**
   * Run A pauses after its contact lookup until run B is either blocked on a lock A
   * holds (serialized) or has made the same lookup (not serialized: both find nothing).
   * B starts once A holds its first lock: two runs importing the route's lazy
   * dependencies at the same moment can bypass vi.mock (see
   * post-call-concurrency.postgres.test.ts).
   */
  async function simultaneously(a: Call, b: Call) {
    let bArrived = () => {};
    const bReady = new Promise<void>((resolve) => (bArrived = resolve));
    let lookups = 0;
    let contended = false;
    h.onContention = () => {
      contended = true;
      bArrived();
    };
    h.afterLookup = async () => {
      lookups += 1;
      if (lookups === 1) await Promise.race([bReady, new Promise((r) => setTimeout(r, 500))]);
      else bArrived();
    };
    const runA = run(a);
    while (h.lockKeys.length === 0) await new Promise((r) => setTimeout(r, 0));
    const responses = await Promise.all([runA, run(b)]);
    return { responses, contended };
  }

  it("two calls from the same new caller create one contact, and both calls are linked to it", async () => {
    const first = seedCall(ORG_A, "+358401234567");
    const second = seedCall(ORG_A, "+358 40 123 4567");

    const { responses, contended } = await simultaneously(first, second);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(contactsIn(ORG_A)).toHaveLength(1);
    expect(contactOf(first)).toBe(contactsIn(ORG_A)[0]!.id);
    expect(contactOf(second)).toBe(contactsIn(ORG_A)[0]!.id);
    // Serialized on the organization and the caller's number, not only the call.
    expect(contended).toBe(true);
    expect(h.lockKeys).toContain(`${ORG_A}:+358401234567`);
  });

  it("the same number written with 00 is the same caller", async () => {
    const first = seedCall(ORG_A, "+358401234567");
    const second = seedCall(ORG_A, "00358401234567");

    await simultaneously(first, second);

    expect(contactsIn(ORG_A)).toHaveLength(1);
    expect(contactOf(first)).toBe(contactOf(second));
  });

  it("the same number in two organizations: one contact in each, neither waits for the other", async () => {
    const a = seedCall(ORG_A, "+358401234567");
    const b = seedCall(ORG_B, "+358401234567");

    const { contended } = await simultaneously(a, b);

    expect(contended).toBe(false);
    expect(contactsIn(ORG_A)).toHaveLength(1);
    expect(contactsIn(ORG_B)).toHaveLength(1);
    expect(contactOf(a)).toBe(contactsIn(ORG_A)[0]!.id);
    expect(contactOf(b)).toBe(contactsIn(ORG_B)[0]!.id);
  });
});
