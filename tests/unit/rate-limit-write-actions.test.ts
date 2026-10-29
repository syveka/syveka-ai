import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared write limit on the CRM, calendar, booking and calendar-integration
 * server actions (actionWriteLimitError): one per-user allowance per area on
 * the `api` limiter, failing closed. The real helpers run against a fake
 * Upstash that counts calls per limiter prefix and key, as in
 * rate-limit-gaps.test.ts.
 */

const s = vi.hoisted(() => ({
  mode: "ok" as "ok" | "timeout" | "throw",
  counts: new Map<string, number>(),
  keys: [] as string[],
  ctx: { orgId: "org-a", userId: "user-1", role: "OWNER" } as Record<string, unknown> | null,
}));

const fx = vi.hoisted(() => ({
  archiveContact: vi.fn(async () => undefined),
  createCompany: vi.fn(async () => ({ id: "co-1" })),
  deleteDeal: vi.fn(async () => undefined),
  createEvent: vi.fn(async () => ({ id: "ev-1", startsAt: new Date() })),
  deleteEvent: vi.fn(async () => undefined),
  saveBookingType: vi.fn(async () => ({ id: "bt-1" })),
  deleteSchedule: vi.fn(async () => undefined),
  setCalendarSyncEnabled: vi.fn(async () => undefined),
  syncExternalCalendar: vi.fn(async () => ({ imported: 0, updated: 0 })),
  ensureWebhookSubscription: vi.fn(async () => undefined),
  checkConnectionHealth: vi.fn(async () => ({ status: "ok" })),
  activateAssistant: vi.fn(async () => ({ phoneNumberError: null })),
  deactivateAssistant: vi.fn(async () => undefined),
}));

vi.mock("@upstash/redis", () => ({ Redis: class Redis {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class Ratelimit {
    static slidingWindow(max: number) {
      return { max };
    }
    private readonly prefix: string;
    private readonly max: number;
    constructor(opts: { prefix: string; limiter: { max: number } }) {
      this.prefix = opts.prefix;
      this.max = opts.limiter.max;
    }
    async limit(key: string) {
      if (s.mode === "throw") throw new Error("fetch failed");
      if (s.mode === "timeout") {
        return { success: true, reason: "timeout", limit: 0, remaining: 0, reset: 0 };
      }
      const id = `${this.prefix}|${key}`;
      s.keys.push(id);
      const used = (s.counts.get(id) ?? 0) + 1;
      s.counts.set(id, used);
      return {
        success: used <= this.max,
        limit: this.max,
        remaining: Math.max(0, this.max - used),
        reset: Date.now() + 60_000,
      };
    }
  },
}));

const { AuthError } = vi.hoisted(() => ({
  AuthError: class AuthError extends Error {
    constructor(
      message: string,
      public readonly status = 403,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/server/auth/session", () => ({ AuthError, getSessionUser: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => {
    if (!s.ctx) throw new AuthError("Missing permission", 403);
    return s.ctx;
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({ externalCalendar: { findFirst: vi.fn(async () => ({ id: "cal-1" })) } }),
}));
vi.mock("@/server/services/contacts", () => ({
  addContactNote: vi.fn(),
  archiveContact: fx.archiveContact,
  createContact: vi.fn(),
  deleteContact: vi.fn(),
  restoreContact: vi.fn(),
  updateContact: vi.fn(),
}));
vi.mock("@/server/services/companies", () => ({
  addCompanyNote: vi.fn(),
  archiveCompany: vi.fn(),
  createCompany: fx.createCompany,
  deleteCompany: vi.fn(),
  restoreCompany: vi.fn(),
  updateCompany: vi.fn(),
}));
vi.mock("@/server/services/deals", () => ({
  addDealNote: vi.fn(),
  addDealTask: vi.fn(),
  createDeal: vi.fn(),
  createStage: vi.fn(),
  DealError: class DealError extends Error {},
  deleteDeal: fx.deleteDeal,
  deleteStage: vi.fn(),
  generateDealInsights: vi.fn(),
  moveDeal: vi.fn(),
  toggleDealTask: vi.fn(),
  updateDeal: vi.fn(),
  updateStage: vi.fn(),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/services/ai-spend", () => ({
  AiSpendError: class AiSpendError extends Error {},
  assertAiSpendAllowed: vi.fn(),
  recordAiSpend: vi.fn(),
}));
vi.mock("@/server/services/calendar", () => ({
  CalendarError: class CalendarError extends Error {},
  cancelEvent: vi.fn(),
  createEvent: fx.createEvent,
  deleteEvent: fx.deleteEvent,
  findConflicts: vi.fn(async () => []),
  updateEvent: vi.fn(),
}));
vi.mock("@/server/services/booking-assistant", () => ({
  assistScheduling: vi.fn(),
  generateMeetingSummary: vi.fn(),
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: vi.fn() }));
vi.mock("@/server/services/booking", () => ({
  BookingError: class BookingError extends Error {},
  deleteBookingType: vi.fn(),
  saveBookingType: fx.saveBookingType,
}));
vi.mock("@/server/services/availability", () => ({
  AvailabilityError: class AvailabilityError extends Error {},
  deleteSchedule: fx.deleteSchedule,
  saveSchedule: vi.fn(),
}));
vi.mock("@/server/services/calendar-connections", () => ({
  checkConnectionHealth: fx.checkConnectionHealth,
  ConnectionError: class ConnectionError extends Error {},
  disconnectConnection: vi.fn(),
  setCalendarSyncEnabled: fx.setCalendarSyncEnabled,
  startConnectionUrl: vi.fn(() => "https://provider.example/auth"),
}));
vi.mock("@/server/services/calendar-sync", () => ({
  ensureWebhookSubscription: fx.ensureWebhookSubscription,
  syncExternalCalendar: fx.syncExternalCalendar,
}));
vi.mock("@/server/services/voice", () => ({
  AssistantNotSyncedError: class AssistantNotSyncedError extends Error {},
  DuplicatePhoneNumberError: class DuplicatePhoneNumberError extends Error {},
  activateAssistant: fx.activateAssistant,
  attachPhoneNumber: vi.fn(),
  deactivateAssistant: fx.deactivateAssistant,
  upsertAssistant: vi.fn(),
}));

import { archiveContactAction } from "@/actions/contacts";
import { createCompanyAction } from "@/actions/companies";
import { deleteDealAction } from "@/actions/deals";
import { deleteEventAction, saveEventAction } from "@/actions/calendar";
import { saveBookingTypeAction } from "@/actions/booking-types";
import { deleteScheduleAction } from "@/actions/availability";
import { syncNowAction, toggleCalendarSyncAction } from "@/actions/calendar-integrations";
import { activateAssistantAction, deactivateAssistantAction } from "@/actions/voice";

const API_LIMIT = 100;
const key = (area: string, org = "org-a", user = "user-1") => `rl:api|${area}-write:${org}:${user}`;

async function exhaust(
  area: "crm" | "calendar" | "booking" | "integrations" | "voice",
): Promise<void> {
  const run = {
    crm: () => archiveContactAction("c-1"),
    calendar: () => deleteEventAction("ev-1"),
    booking: () => deleteScheduleAction("sch-1"),
    integrations: () => toggleCalendarSyncAction("cal-1", false),
    voice: () => deactivateAssistantAction("va-1", {}),
  }[area];
  for (let i = 0; i < API_LIMIT; i++) await run();
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  s.mode = "ok";
  s.counts.clear();
  s.keys.length = 0;
  s.ctx = { orgId: "org-a", userId: "user-1", role: "OWNER" };
  for (const mock of Object.values(fx)) mock.mockClear();
});

describe("CRM writes share one per-user allowance", () => {
  it("runs under the limit and stops at the 101st write in a minute, changing nothing", async () => {
    await exhaust("crm");
    expect(fx.archiveContact).toHaveBeenCalledTimes(API_LIMIT);

    await archiveContactAction("c-101");
    expect(fx.archiveContact).toHaveBeenCalledTimes(API_LIMIT);
    await deleteDealAction("d-1");
    expect(fx.deleteDeal).not.toHaveBeenCalled();
    expect(s.counts.get(key("crm"))).toBe(API_LIMIT + 2);
  });

  it("a form action reports rate_limited (before even validating the input)", async () => {
    await exhaust("crm");
    const state = await createCompanyAction({}, new FormData());
    expect(state).toEqual({ error: "rate_limited" });
    expect(fx.createCompany).not.toHaveBeenCalled();
  });

  it("is per user: a colleague in the organization isn't blocked", async () => {
    await exhaust("crm");
    s.ctx = { orgId: "org-a", userId: "user-2", role: "MEMBER" };
    await archiveContactAction("c-1");
    expect(fx.archiveContact).toHaveBeenCalledTimes(API_LIMIT + 1);
    expect(s.counts.get(key("crm", "org-a", "user-2"))).toBe(1);
  });

  it("is per organization: another organization's allowance is its own", async () => {
    await exhaust("crm");
    s.ctx = { orgId: "org-b", userId: "user-1", role: "OWNER" };
    await archiveContactAction("c-1");
    expect(fx.archiveContact).toHaveBeenCalledTimes(API_LIMIT + 1);
  });

  it("is per area: an exhausted CRM allowance doesn't block the calendar or booking set-up", async () => {
    await exhaust("crm");
    expect(await saveBookingTypeAction(undefined, {}, new FormData())).toEqual({
      error: "invalid_input",
    });
    expect(await saveEventAction(undefined, {}, new FormData())).toEqual({
      error: "invalid_input",
    });
    expect(s.counts.get(key("booking"))).toBe(1);
    expect(s.counts.get(key("calendar"))).toBe(1);
  });

  it("checks the permission before counting anything", async () => {
    s.ctx = null;
    await expect(archiveContactAction("c-1")).rejects.toBeInstanceOf(AuthError);
    expect(s.keys).toEqual([]);
  });

  it("keys carry only the area and ids, never form content", () => {
    void archiveContactAction("c-1");
    return archiveContactAction("c-2").then(() => {
      expect(s.keys.every((k) => k === key("crm"))).toBe(true);
    });
  });
});

describe("calendar, booking and integrations", () => {
  it("calendar: the 101st event write is refused and nothing is created or deleted", async () => {
    await exhaust("calendar");
    expect(fx.deleteEvent).toHaveBeenCalledTimes(API_LIMIT);
    expect(await deleteEventAction("ev-x")).toEqual({ error: "rate_limited" });
    expect(await saveEventAction(undefined, {}, new FormData())).toEqual({ error: "rate_limited" });
    expect(fx.createEvent).not.toHaveBeenCalled();
    expect(fx.deleteEvent).toHaveBeenCalledTimes(API_LIMIT);
  });

  it("booking set-up: the 101st change is refused", async () => {
    await exhaust("booking");
    expect(await deleteScheduleAction("sch-x")).toEqual({ error: "rate_limited" });
    expect(fx.deleteSchedule).toHaveBeenCalledTimes(API_LIMIT);
  });

  it("integrations: while refused, no provider sync, webhook or health call happens", async () => {
    await exhaust("integrations");
    fx.setCalendarSyncEnabled.mockClear();
    expect(await toggleCalendarSyncAction("cal-1", true)).toEqual({ error: "rate_limited" });
    expect(await syncNowAction("cal-1")).toEqual({ error: "rate_limited" });
    expect(fx.setCalendarSyncEnabled).not.toHaveBeenCalled();
    expect(fx.syncExternalCalendar).not.toHaveBeenCalled();
    expect(fx.ensureWebhookSubscription).not.toHaveBeenCalled();
  });
});

describe("voice (every action calls the paid voice provider)", () => {
  it("the 101st change is refused with rate_limited and no provider call is made", async () => {
    await exhaust("voice");
    expect(fx.deactivateAssistant).toHaveBeenCalledTimes(API_LIMIT);

    expect(await activateAssistantAction("va-1", {})).toEqual({ error: "rate_limited" });
    expect(fx.activateAssistant).not.toHaveBeenCalled();
    expect(s.counts.get(key("voice"))).toBe(API_LIMIT + 1);
  });

  it("is its own area: an exhausted voice allowance doesn't block CRM, and vice versa", async () => {
    await exhaust("voice");
    await archiveContactAction("c-1");
    expect(fx.archiveContact).toHaveBeenCalledTimes(1);
  });

  it("a Redis timeout refuses with service_unavailable and calls no provider", async () => {
    s.mode = "timeout";
    expect(await activateAssistantAction("va-1", {})).toEqual({ error: "service_unavailable" });
    expect(fx.activateAssistant).not.toHaveBeenCalled();
  });
});

describe("fails closed", () => {
  it("a Redis timeout refuses with service_unavailable and changes nothing", async () => {
    s.mode = "timeout";
    expect(await createCompanyAction({}, new FormData())).toEqual({ error: "service_unavailable" });
    expect(await deleteEventAction("ev-1")).toEqual({ error: "service_unavailable" });
    await archiveContactAction("c-1");
    expect(fx.createCompany).not.toHaveBeenCalled();
    expect(fx.deleteEvent).not.toHaveBeenCalled();
    expect(fx.archiveContact).not.toHaveBeenCalled();
  });

  it("a Redis error refuses with service_unavailable and changes nothing", async () => {
    s.mode = "throw";
    expect(await toggleCalendarSyncAction("cal-1", true)).toEqual({ error: "service_unavailable" });
    expect(await saveBookingTypeAction(undefined, {}, new FormData())).toEqual({
      error: "service_unavailable",
    });
    expect(fx.setCalendarSyncEnabled).not.toHaveBeenCalled();
    expect(fx.saveBookingType).not.toHaveBeenCalled();
  });
});

describe("every write action in these modules is covered (drift guard)", () => {
  const root = path.join(__dirname, "../../src/actions");
  const modules: Record<string, string[]> = {
    "contacts.ts": [],
    "companies.ts": [],
    "deals.ts": ["generateDealInsightsAction"],
    "calendar.ts": ["schedulingAssistantAction", "meetingSummaryAction"],
    "booking-types.ts": [],
    "availability.ts": [],
    "calendar-integrations.ts": [],
    "voice.ts": [],
  };

  it.each(Object.entries(modules))("%s", (file, aiActionsWithTheirOwnLimit) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const bodies = source.split(/^export async function /m).slice(1);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      const limited = body.includes("actionWriteLimitError(");
      expect(limited, `${file}: ${name}`).toBe(!aiActionsWithTheirOwnLimit.includes(name));
    }
  });
});
